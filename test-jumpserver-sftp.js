// Test script for JumpServer SFTP connectivity
// This script mimics the command-line SFTP connection process

const { Client } = require('ssh2')
const fs = require('fs')
const readline = require('readline')

// Configuration - adjust these values as needed
const CONFIG = {
  host: 'jump.itouchtv.cn',
  port: 2222,
  username: 'hepingtao@itouchtv@192.168.31.20',
  privateKeyPath: 'C:/Users/hepingtao/.ssh/jumpserver_vscode_key',
  // If you have a passphrase for the key, set it here
  passphrase: undefined,
  // Test paths to verify
  testPaths: ['/', '/A100', '/A100/测试linux普通-账号模版', '/A100/测试linux普通-账号模版/home', '/A100/测试linux普通-账号模版/home/itouchtv']
}

console.log('=== JumpServer SFTP Connectivity Test ===\n')
console.log('Configuration:')
console.log('  Host:', CONFIG.host)
console.log('  Port:', CONFIG.port)
console.log('  Username:', CONFIG.username)
console.log('  Private Key:', CONFIG.privateKeyPath)
console.log('')

// Read private key
let privateKey
try {
  privateKey = fs.readFileSync(CONFIG.privateKeyPath)
  console.log('✓ Private key loaded successfully')
  console.log('  Key length:', privateKey.length, 'bytes')
} catch (err) {
  console.error('✗ Failed to load private key:', err.message)
  process.exit(1)
}

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

// Create SSH client
const conn = new Client()
let otpPrompted = false

// Debug: Log all authentication attempts
conn.on('authentication', (methodsLeft, partialSuccess, methods) => {
  console.log('[Auth] Methods left:', methodsLeft)
  console.log('[Auth] Partial success:', partialSuccess)
  console.log('[Auth] Methods:', methods)
})

// Handle keyboard-interactive authentication (for MFA)
conn.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
  console.log('\n[Keyboard-Interactive]')
  console.log('  Name:', name)
  console.log('  Instructions:', instructions)
  console.log('  Lang:', lang)
  console.log('  Prompts:', JSON.stringify(prompts, null, 2))

  if (otpPrompted) {
    console.log('  Already prompted, skipping...')
    return
  }
  otpPrompted = true

  if (prompts.length > 0) {
    const prompt = prompts[0]
    rl.question(`\n${prompt.prompt} `, (answer) => {
      finish([answer])
    })
  } else {
    finish([])
  }
})

// Handle connection ready
conn.on('ready', () => {
  console.log('\n✓ SSH connection established')

  // Try to establish SFTP session
  conn.sftp((err, sftp) => {
    if (err) {
      console.error('✗ SFTP session failed:', err.message)
      rl.close()
      conn.end()
      return
    }

    console.log('✓ SFTP session established\n')

    // Test each path
    console.log('Testing directory access:')
    console.log('------------------------')

    let testIndex = 0

    function testNextPath() {
      if (testIndex >= CONFIG.testPaths.length) {
        console.log('\n------------------------')
        console.log('All tests completed')
        rl.close()
        sftp.end()
        conn.end()
        return
      }

      const testPath = CONFIG.testPaths[testIndex]
      testIndex++

      process.stdout.write(`Testing ${testPath}... `)

      sftp.readdir(testPath, (err, list) => {
        if (err) {
          console.log(`✗ FAILED (${err.message})`)
        } else {
          console.log(`✓ SUCCESS (${list.length} items)`)
          // Show first few items
          if (list.length > 0) {
            console.log(
              '  Sample items:',
              list
                .slice(0, 3)
                .map((item) => item.filename)
                .join(', ')
            )
          }
        }

        testNextPath()
      })
    }

    testNextPath()
  })
})

// Handle errors
conn.on('error', (err) => {
  console.error('\n✗ Connection error:', err.message)
  console.error('  Code:', err.code)
  console.error('  Level:', err.level)
  rl.close()
})

conn.on('close', () => {
  console.log('\n=== Connection closed ===')
})

// Start connection
console.log('\nConnecting...\n')

const connectConfig = {
  host: CONFIG.host,
  port: CONFIG.port,
  username: CONFIG.username,
  privateKey: privateKey,
  passphrase: CONFIG.passphrase,
  tryKeyboard: true,
  readyTimeout: 30000,
  keepaliveInterval: 10000,
  debug: (message) => {
    // Log authentication-related debug messages
    if (message.includes('auth') || message.includes('Auth') || message.includes('keyboard')) {
      console.log('[DEBUG]', message)
    }
  }
}

conn.connect(connectConfig)
