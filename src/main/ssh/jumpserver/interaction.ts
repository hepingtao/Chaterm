import { BrowserWindow } from 'electron'
import type { Client } from 'ssh2'
import type { JumpServerConnectionInfo, JumpServerNavigationPath } from './constants'
import {
  jumpserverConnections,
  jumpserverShellStreams,
  jumpserverConnectionStatus,
  jumpserverLastCommand,
  jumpserverInputBuffer,
  jumpserverPendingData
} from './state'
import { createJumpServerExecStream, executeCommandOnJumpServerExec } from './streamManager'
import { parseJumpServerUsers, hasUserSelectionPrompt } from './parser'
import { handleJumpServerUserSelectionWithEvent } from './userSelection'
import { hasPasswordPrompt, hasPasswordError, detectDirectConnectionReason, hasNoAssetsPrompt, createNoAssetsError } from './navigator'
import { JUMPSERVER_CONSTANTS } from './constants'
const logger = createLogger('jumpserver')

const sendPasswordToStream = (stream: any, password: string, navigationPath: JumpServerNavigationPath, context: string = '') => {
  const actualPassword = password || ''
  navigationPath.needsPassword = !!actualPassword
  navigationPath.password = actualPassword

  setTimeout(() => {
    logger.debug('Sending password to JumpServer', { event: 'jumpserver.auth.password', context })
    stream.write(actualPassword + '\r')
  }, JUMPSERVER_CONSTANTS.PASSWORD_INPUT_DELAY)
}

export const setupJumpServerInteraction = (
  stream: any,
  connectionInfo: JumpServerConnectionInfo,
  connectionId: string,
  jumpserverUuid: string,
  conn: Client,
  event: Electron.IpcMainInvokeEvent | undefined,
  sendStatusUpdate: (
    message: string,
    type: 'info' | 'success' | 'warning' | 'error',
    messageKey?: string,
    messageParams?: Record<string, string | number>
  ) => void,
  resolve: (value: { status: string; message: string }) => void,
  reject: (reason: Error) => void,
  inheritedNavigationPath?: JumpServerNavigationPath
) => {
  let outputBuffer = ''
  let connectionPhase: 'connecting' | 'inputIp' | 'selectUser' | 'inputPassword' | 'connected' = 'connecting'
  let connectionEstablished = false
  let connectionFailed = false

  // Connection-level timeout to prevent indefinite hanging
  const interactionTimeout = setTimeout(() => {
    if (connectionPhase !== 'connected' && !connectionFailed) {
      logger.error('JumpServer interaction timeout', { event: 'jumpserver.interaction.timeout', connectionId, phase: connectionPhase })
      stream.end()
      reject(new Error('JumpServer connection timeout: Interaction with JumpServer menu did not complete in time'))
    }
  }, JUMPSERVER_CONSTANTS.INTERACTION_TIMEOUT)

  // When reusing an existing connection, inherit the navigation path so that
  // multi-user selection and password can be auto-replayed without user intervention.
  const navigationPath: JumpServerNavigationPath = inheritedNavigationPath ? { ...inheritedNavigationPath } : { needsPassword: false }

  const handleConnectionSuccess = async (reason: string) => {
    if (connectionEstablished) return
    connectionEstablished = true
    clearTimeout(interactionTimeout)
    sendStatusUpdate('Successfully connected to target server, you can start operating', 'success', 'ssh.jumpserver.connectedToTarget')
    connectionPhase = 'connected'
    outputBuffer = ''

    logger.info('JumpServer connection successful', { event: 'jumpserver.connect.success', connectionId, reason })
    jumpserverConnections.set(connectionId, {
      conn,
      stream,
      jumpserverUuid,
      targetIp: connectionInfo.targetIp,
      navigationPath
    })
    jumpserverShellStreams.set(connectionId, stream)
    jumpserverConnectionStatus.set(connectionId, { isVerified: true })
    // Initialize pending data buffer to capture data between connection success and shell start
    jumpserverPendingData.set(connectionId, [])

    // Wait for exec stream creation with timeout before resolving connection
    // This ensures the terminal is actually functional when we report success
    const postConnectSetup = async () => {
      try {
        const execStream = await Promise.race([
          createJumpServerExecStream(connectionId),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('JumpServer exec stream creation timeout')), JUMPSERVER_CONSTANTS.NAVIGATION_TIMEOUT)
          )
        ])

        const readyResult = {
          hasSudo: false,
          commandList: [] as string[]
        }

        try {
          const commandListResult = await executeCommandOnJumpServerExec(
            execStream,
            'sh -c \'if command -v bash >/dev/null 2>&1; then bash -lc "compgen -A builtin; compgen -A command"; bash -ic "compgen -A alias" 2>/dev/null; else IFS=:; for d in $PATH; do [ -d "$d" ] || continue; for f in "$d"/*; do [ -x "$f" ] && printf "%s\\n" "${f##*/}"; done; done; fi\' | sort -u'
          ).then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason) => ({ status: 'rejected' as const, reason })
          )

          const sudoCheckResult = await executeCommandOnJumpServerExec(execStream, 'sudo -n true 2>/dev/null && echo true || echo false').then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason) => ({ status: 'rejected' as const, reason })
          )

          if (commandListResult.status === 'fulfilled' && commandListResult.value.success) {
            const stdout = commandListResult.value.stdout || ''
            readyResult.commandList = stdout.split('\n').filter(Boolean)

            if (readyResult.commandList.length === 0) {
              logger.warn('Command list is empty', { event: 'jumpserver.commandlist.empty' })
            }
          } else if (commandListResult.status === 'fulfilled') {
            logger.error('Failed to get command list', { event: 'jumpserver.commandlist.error', error: commandListResult.value.error })
          }

          if (sudoCheckResult.status === 'fulfilled' && sudoCheckResult.value.success) {
            readyResult.hasSudo = (sudoCheckResult.value.stdout || '').trim() === 'true'
          }
        } catch (error) {
          logger.error('Error getting command list', {
            event: 'jumpserver.commandlist.error',
            error: error
          })
        }

        const mainWindow = BrowserWindow.getAllWindows()[0]
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(`ssh:connect:data:${connectionId}`, readyResult)
        }
      } catch (error) {
        logger.error('JumpServer exec stream creation failed or timed out', {
          event: 'jumpserver.exec.create.error',
          connectionId,
          error: error
        })

        const mainWindow = BrowserWindow.getAllWindows()[0]
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(`ssh:connect:data:${connectionId}`, {
            hasSudo: false,
            commandList: []
          })
          logger.debug('Sent empty command list to frontend (exec stream creation failed)', {
            event: 'jumpserver.commandlist.fallback',
            connectionId
          })
        } else {
          logger.error('Cannot send empty command list: window does not exist or is destroyed', { event: 'jumpserver.window.notfound', connectionId })
        }
      }
    }

    await postConnectSetup()
    resolve({ status: 'connected', message: 'Connection successful' })
  }

  stream.on('data', (data: Buffer) => {
    const ansiRegex = /[\u001b\u009b][[()#;?]*.{0,2}(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nry=><]/g
    const chunk = data.toString().replace(ansiRegex, '')
    outputBuffer += chunk

    if (connectionPhase === 'connecting' && outputBuffer.includes('Opt>')) {
      logger.debug('JumpServer menu detected, entering target IP', { event: 'jumpserver.menu.detected', connectionId })
      sendStatusUpdate('Connecting to target server...', 'info', 'ssh.jumpserver.connectingToTarget')
      connectionPhase = 'inputIp'
      outputBuffer = ''
      stream.write(connectionInfo.targetIp + '\r')
      return
    }

    if (connectionPhase === 'inputIp') {
      if (hasNoAssetsPrompt(outputBuffer)) {
        logger.warn('JumpServer asset not found for target IP', {
          event: 'jumpserver.asset.notfound',
          connectionId,
          targetIp: connectionInfo.targetIp
        })
        connectionFailed = true
        outputBuffer = ''
        stream.end()

        const hasOtherSessions = Array.from(jumpserverConnections.values()).some((item) => item.conn === conn)
        if (!hasOtherSessions) {
          conn.end()
        }

        reject(createNoAssetsError())
        return
      }

      if (hasUserSelectionPrompt(outputBuffer)) {
        logger.debug('Multiple user prompt detected, user selection required', { event: 'jumpserver.user.selection', connectionId })

        const users = parseJumpServerUsers(outputBuffer)
        logger.debug('Parsed user list', { event: 'jumpserver.user.parsed', connectionId, userCount: users.length })

        if (users.length === 0) {
          logger.error('Failed to parse user list', { event: 'jumpserver.user.parse.error', connectionId })
          conn.end()
          reject(new Error('Failed to parse user list'))
          return
        }

        outputBuffer = ''

        // If we have an inherited selectedUserId (from a reused connection), auto-select it
        if (navigationPath.selectedUserId !== undefined) {
          logger.debug('Auto-selecting inherited user for reused connection', {
            event: 'jumpserver.user.autoselect',
            connectionId,
            selectedUserId: navigationPath.selectedUserId
          })
          sendStatusUpdate('Auto-selecting account from previous session...', 'info', 'ssh.jumpserver.connectingWithSelectedAccount')
          connectionPhase = 'inputPassword'
          stream.write(navigationPath.selectedUserId.toString() + '\r')
          return
        }

        sendStatusUpdate('Multiple user accounts detected, please select...', 'info', 'ssh.jumpserver.multipleUsersDetected')
        connectionPhase = 'selectUser'

        if (!event) {
          logger.error('JumpServer user selection requires event object', { event: 'jumpserver.user.event.missing', connectionId })
          conn.end()
          reject(new Error('User selection requires event object'))
          return
        }

        handleJumpServerUserSelectionWithEvent(event, connectionId, users)
          .then((selectedUserId) => {
            logger.debug('User selected account', { event: 'jumpserver.user.selected', connectionId, selectedUserId })
            sendStatusUpdate('Connecting with selected account...', 'info', 'ssh.jumpserver.connectingWithSelectedAccount')
            connectionPhase = 'inputPassword'

            navigationPath.selectedUserId = selectedUserId

            stream.write(selectedUserId.toString() + '\r')
          })
          .catch((err) => {
            logger.error('User selection failed', {
              event: 'jumpserver.user.selection.error',
              connectionId,
              error: err
            })
            sendStatusUpdate('User selection cancelled', 'error', 'ssh.jumpserver.userSelectionCanceled')
            conn.end()
            reject(err)
          })
        return
      }

      if (hasPasswordPrompt(outputBuffer)) {
        sendStatusUpdate('Authenticating...', 'info', 'ssh.jumpserver.authenticating')
        connectionPhase = 'inputPassword'
        outputBuffer = ''
        sendPasswordToStream(stream, connectionInfo.password || '', navigationPath, 'After IP input')
        return
      }

      const reason = detectDirectConnectionReason(outputBuffer)
      if (reason) {
        logger.debug('JumpServer target asset requires no password, direct connection', { event: 'jumpserver.connect.direct', connectionId, reason })
        handleConnectionSuccess(`No password required - ${reason}`)
      } else {
        const lines = outputBuffer.split(/\r?\n/).filter(Boolean)
        const sampleLines = lines.slice(0, 3).concat(lines.slice(-3))
        logger.info('JumpServer inputIp phase waiting for more output', {
          event: 'jumpserver.inputIp.waiting',
          connectionId,
          bufferSize: outputBuffer.length,
          lineCount: lines.length,
          sampleLines: sampleLines.map((l) => l.substring(0, 80)),
          hasPassword: hasPasswordPrompt(outputBuffer),
          hasUserSelection: hasUserSelectionPrompt(outputBuffer),
          hasNoAssets: hasNoAssetsPrompt(outputBuffer),
          hasDirectReason: !!detectDirectConnectionReason(outputBuffer)
        })
      }
      return
    }

    if (connectionPhase === 'selectUser') {
      if (hasPasswordPrompt(outputBuffer)) {
        sendStatusUpdate('Authenticating...', 'info', 'ssh.jumpserver.authenticating')
        connectionPhase = 'inputPassword'
        outputBuffer = ''
        sendPasswordToStream(stream, connectionInfo.password || '', navigationPath, 'After user selection')
        return
      }

      const reason = detectDirectConnectionReason(outputBuffer)
      if (reason) {
        logger.debug('JumpServer direct connection after user selection', { event: 'jumpserver.connect.direct', connectionId, reason })
        handleConnectionSuccess(`User selection - ${reason}`)
      }
      return
    }

    if (connectionPhase === 'inputPassword') {
      if (hasPasswordError(outputBuffer)) {
        logger.warn('JumpServer password authentication failed', { event: 'jumpserver.auth.failed', connectionId })

        if (event) {
          event.sender.send('ssh:keyboard-interactive-result', {
            id: connectionId,
            status: 'failed'
          })
        }

        conn.end()
        reject(new Error('JumpServer password authentication failed, please check if password is correct'))
        return
      }

      const reason = detectDirectConnectionReason(outputBuffer)
      if (reason) {
        logger.debug('JumpServer entered target server after password verification', { event: 'jumpserver.auth.success', connectionId, reason })
        handleConnectionSuccess(`After password verification - ${reason}`)
      } else {
        const lines = outputBuffer.split(/\r?\n/).filter(Boolean)
        const sampleLines = lines.slice(0, 3).concat(lines.slice(-3))
        logger.info('JumpServer inputPassword phase waiting for connection success', {
          event: 'jumpserver.inputPassword.waiting',
          connectionId,
          bufferSize: outputBuffer.length,
          lineCount: lines.length,
          sampleLines: sampleLines.map((l) => l.substring(0, 80)),
          hasPasswordError: hasPasswordError(outputBuffer),
          hasDirectReason: !!detectDirectConnectionReason(outputBuffer)
        })
      }
    }

    // Buffer data in connected phase to prevent loss between connection success and shell start
    // The ssh:shell handler will flush this buffer when it takes over the stream
    if (connectionPhase === 'connected') {
      const pending = jumpserverPendingData.get(connectionId)
      if (pending) {
        pending.push(data)
      }
      return
    }
  })

  stream.stderr.on('data', (data: Buffer) => {
    logger.debug('JumpServer stderr received', { event: 'jumpserver.stderr', connectionId, size: data.length })
  })

  stream.on('close', () => {
    clearTimeout(interactionTimeout)
    logger.debug('JumpServer stream closed', { event: 'jumpserver.stream.close', connectionId })

    // Check if underlying SSH connection needs to be closed
    const connData = jumpserverConnections.get(connectionId)
    if (connData) {
      const connToClose = connData.conn

      // Check if other sessions are still using the same connection
      let isConnStillInUse = false
      for (const [otherId, otherData] of jumpserverConnections.entries()) {
        if (otherId !== connectionId && otherData.conn === connToClose) {
          isConnStillInUse = true
          break
        }
      }

      // Only close underlying connection when no other sessions are using it
      if (!isConnStillInUse) {
        logger.info('All sessions closed, releasing underlying connection', { event: 'jumpserver.disconnect', connectionId })
        connToClose.end()
      } else {
        logger.debug('Session closed, underlying connection still in use', { event: 'jumpserver.disconnect.partial', connectionId })
      }
    }

    // Clean up session data
    jumpserverShellStreams.delete(connectionId)
    jumpserverConnections.delete(connectionId)
    jumpserverConnectionStatus.delete(connectionId)
    jumpserverLastCommand.delete(connectionId)
    jumpserverInputBuffer.delete(connectionId)
    jumpserverPendingData.delete(connectionId)

    if (connectionPhase !== 'connected' && !connectionFailed) {
      reject(new Error('Connection closed before completion'))
    }
  })

  stream.on('error', (error: Error) => {
    clearTimeout(interactionTimeout)
    logger.error('JumpServer stream error', { event: 'jumpserver.stream.error', connectionId, error: error.message })
    reject(error)
  })
}
