/**
 * 独立测试脚本：探测 JumpServer 虚拟 SFTP 文件系统目录结构
 *
 * 用途：
 *   1. 通过 SFTP 连接到 JumpServer 堡垒机，递归遍历虚拟文件系统目录树
 *   2. 找到所有包含 home/<username> 的资产路径
 *   3. 同时尝试 JumpServer REST API 获取资产的节点路径（nodes 字段）
 *
 * 用法：
 *   node scripts/test-jumpserver-sftp-paths.mjs \
 *     --host <堡垒机IP> \
 *     --port <SSH端口, 默认2222> \
 *     --user <用户名> \
 *     --password <密码> \
 *     --asset <资产名称关键词, 如: 测试linux普通> \
 *     [--api-url <JumpServer API地址, 如: https://堡垒机IP/api/v1>] \
 *     [--api-token <JumpServer API Token>]
 *
 * 示例：
 *   node scripts/test-jumpserver-sftp-paths.mjs \
 *     --host 10.0.0.1 --port 2222 --user admin --password 'xxx' \
 *     --asset '测试linux普通'
 *
 * 注意：
 *   - SFTP 端口通常是 JumpServer 的 SFTP 端口（默认 2222），不是 SSH 端口（22）
 *   - 如果堡垒机启用了 MFA，SFTP 方式可能无法直接使用，需要先通过 SSH 获取 session
 *   - API Token 可以从 JumpServer 管理后台创建（个人设置 -> API 令牌）
 */

import { Client as SSHClient } from 'ssh2'
import https from 'node:https'
import http from 'node:http'

// ─── 参数解析 ───────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2)
  const opts = {
    host: '',
    port: 2222,
    user: '',
    password: '',
    privateKey: '',
    passphrase: '',
    asset: '',
    apiUrl: '',
    apiToken: '',
    maxDepth: 10,
    readdirTimeout: 8000
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--host':
        opts.host = args[++i]
        break
      case '--port':
        opts.port = parseInt(args[++i], 10) || 2222
        break
      case '--user':
        opts.user = args[++i]
        break
      case '--password':
        opts.password = args[++i]
        break
      case '--private-key':
        opts.privateKey = args[++i]
        break
      case '--passphrase':
        opts.passphrase = args[++i]
        break
      case '--asset':
        opts.asset = args[++i]
        break
      case '--api-url':
        opts.apiUrl = args[++i]
        break
      case '--api-token':
        opts.apiToken = args[++i]
        break
      case '--max-depth':
        opts.maxDepth = parseInt(args[++i], 10) || 10
        break
      case '--help':
        console.log(`
用法: node scripts/test-jumpserver-sftp-paths.mjs [options]

选项:
  --host <ip>           堡垒机 IP 地址 (必填)
  --port <port>         SFTP 端口 (默认: 2222)
  --user <username>     用户名 (必填)
  --password <pwd>      密码
  --private-key <path>  私钥文件路径
  --passphrase <pwd>    私钥密码
  --asset <keyword>     资产名称关键词 (用于搜索)
  --api-url <url>       JumpServer REST API 地址 (可选)
  --api-token <token>   JumpServer API Token (可选)
  --max-depth <n>       最大遍历深度 (默认: 10)
  --help                显示帮助
`)
        process.exit(0)
    }
  }

  if (!opts.host || !opts.user) {
    console.error('错误: --host 和 --user 是必填参数。使用 --help 查看帮助。')
    process.exit(1)
  }

  if (!opts.password && !opts.privateKey) {
    console.error('错误: 需要提供 --password 或 --private-key。')
    process.exit(1)
  }

  return opts
}

// ─── 工具函数 ───────────────────────────────────────────────
function joinPath(base, name) {
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`
}

function isDirEntry(ent) {
  if (ent?.attrs?.isDirectory) return !!ent.attrs.isDirectory()
  if (typeof ent?.longname === 'string') return ent.longname.startsWith('d')
  return false
}

function readdirWithTimeout(sftp, dir, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`readdir timeout: ${dir} (${timeoutMs}ms)`))
    }, timeoutMs)

    sftp.readdir(dir, (err, entries) => {
      clearTimeout(timer)
      if (err) return reject(err)
      resolve(entries)
    })
  })
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ─── 方式 1: SFTP 虚拟文件系统遍历 ─────────────────────────
async function exploreSftpTree(sftp, root, maxDepth, readdirTimeout, assetKeyword) {
  const results = {
    tree: {},
    homeDirs: [], // 所有找到的 home/<username> 路径
    assetPaths: [], // 匹配资产关键词的路径
    totalDirs: 0,
    totalReaddirs: 0,
    errors: []
  }

  const hint = assetKeyword?.toLowerCase().trim()

  async function search(dir, depth, pathChain) {
    if (depth > maxDepth) return

    results.totalDirs++
    let entries
    try {
      entries = await readdirWithTimeout(sftp, dir, readdirTimeout)
      results.totalReaddirs++
    } catch (err) {
      results.errors.push({ dir, error: err.message })
      return
    }

    // 检查当前层级是否有 home 目录
    const homeEntry = entries.find((e) => e.filename === 'home' && isDirEntry(e))
    if (homeEntry) {
      const homePath = joinPath(dir, 'home')
      try {
        const homeEntries = await readdirWithTimeout(sftp, homePath, readdirTimeout)
        results.totalReaddirs++
        for (const ent of homeEntries) {
          if (ent.filename === '.' || ent.filename === '..') continue
          const userHomePath = joinPath(homePath, ent.filename)
          results.homeDirs.push({
            path: userHomePath,
            parentTree: pathChain.join('/'),
            username: ent.filename
          })
          console.log(`  [HOME 找到] ${userHomePath}`)
        }
      } catch (err) {
        results.errors.push({ dir: homePath, error: err.message })
      }
    }

    // 递归进入子目录
    const subdirs = entries.filter((e) => e.filename !== '.' && e.filename !== '..' && e.filename !== 'home' && isDirEntry(e))

    // 如果有资产关键词，优先搜索匹配的子目录
    if (hint) {
      subdirs.sort((a, b) => {
        const aM = a.filename.toLowerCase().includes(hint) ? 0 : 1
        const bM = b.filename.toLowerCase().includes(hint) ? 0 : 1
        return aM - bM
      })
    }

    // 构建树结构（限制显示深度）
    const treeKey = pathChain[pathChain.length - 1] || '/'
    if (depth <= 4) {
      results.tree[treeKey] = subdirs.map((e) => e.filename)
    }

    for (const entry of subdirs) {
      const subPath = joinPath(dir, entry.filename)
      // 检查是否匹配资产关键词
      if (hint && entry.filename.toLowerCase().includes(hint)) {
        results.assetPaths.push({
          name: entry.filename,
          path: subPath,
          depth,
          parentTree: pathChain.join('/')
        })
        console.log(`  [资产匹配] ${subPath} (depth=${depth})`)
      }
      await search(subPath, depth + 1, [...pathChain, entry.filename])
    }
  }

  console.log(`\n开始遍历 SFTP 虚拟文件系统 (root=/, maxDepth=${maxDepth})...`)
  if (hint) console.log(`资产关键词: "${assetKeyword}"，将优先搜索匹配目录\n`)

  await search(root, 0, [])
  return results
}

// ─── 方式 2: JumpServer REST API ────────────────────────────
function fetchApi(apiUrl, path, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, apiUrl)
    const lib = url.protocol === 'https:' ? https : http

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`
      },
      rejectUnauthorized: false // JumpServer 常用自签证书
    }

    const req = lib.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`API ${path} 返回 ${res.statusCode}: ${data.substring(0, 200)}`))
          return
        }
        try {
          resolve(JSON.parse(data))
        } catch {
          reject(new Error(`API ${path} 返回非 JSON: ${data.substring(0, 200)}`))
        }
      })
    })

    req.on('error', reject)
    req.setTimeout(10000, () => {
      req.destroy(new Error('API 请求超时'))
    })
    req.end()
  })
}

async function tryJumpServerApi(opts) {
  if (!opts.apiUrl || !opts.apiToken) {
    console.log('\n[API] 未提供 --api-url 或 --api-token，跳过 REST API 方式')
    console.log('[API] 提示: 可通过 --api-url <url> --api-token <token> 启用 API 查询')
    console.log('[API] JumpServer API 可直接返回资产的 nodes 字段（完整节点路径）')
    return null
  }

  console.log(`\n[API] 尝试 JumpServer REST API: ${opts.apiUrl}`)

  try {
    // 获取当前用户的资产列表（含 nodes 字段）
    const data = await fetchApi(opts.apiUrl, '/api/v1/perms/users/self/assets/?limit=1000', opts.apiToken)
    const assets = Array.isArray(data) ? data : data.results || []

    console.log(`[API] 获取到 ${assets.length} 个资产\n`)

    const results = []
    const hint = opts.asset?.toLowerCase().trim()

    for (const asset of assets) {
      const info = {
        id: asset.id,
        name: asset.hostname || asset.name,
        ip: asset.ip || asset.address,
        platform: asset.platform?.name || asset.platform,
        nodes: asset.nodes || [],
        orgName: asset.org_name
      }

      if (!hint || (info.name && info.name.toLowerCase().includes(hint)) || (info.ip && info.ip.includes(opts.asset))) {
        results.push(info)
        console.log(`[API] 资产: ${info.name} (${info.ip})`)
        console.log(`       nodes: ${JSON.stringify(info.nodes)}`)
        console.log(`       组织: ${info.orgName || 'N/A'}`)
      }
    }

    if (results.length === 0) {
      console.log('[API] 未找到匹配的资产')
    }

    // 如果有 nodes 信息，构建完整 SFTP 路径
    for (const r of results) {
      if (r.nodes && r.nodes.length > 0) {
        // nodes 格式通常是 ["/触电研发中心/测试环境/大数据/A100/"]
        // SFTP 虚拟路径 = node_path + asset_name + /home/ + username
        for (const nodePath of r.nodes) {
          const sftpPath = `${nodePath}${r.name}/home/${opts.user}`
          console.log(`[API] 推测 SFTP 路径: ${sftpPath}`)
        }
      }
    }

    return results
  } catch (err) {
    console.error(`[API] 请求失败: ${err.message}`)
    console.error('[API] 提示: 确认 API URL 正确、Token 有效、网络可达')
    return null
  }
}

// ─── 主流程 ─────────────────────────────────────────────────
async function main() {
  const opts = parseArgs()

  console.log('═══════════════════════════════════════════════════════')
  console.log('  JumpServer SFTP 虚拟文件系统路径探测脚本')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`堡垒机: ${opts.host}:${opts.port}`)
  console.log(`用户名: ${opts.user}`)
  console.log(`资产关键词: ${opts.asset || '(无)'}`)
  console.log(`API: ${opts.apiUrl || '(未配置)'}`)
  console.log('═══════════════════════════════════════════════════════\n')

  // ── 方式 2 先行: REST API (不依赖 SSH 连接) ──
  await tryJumpServerApi(opts)

  // ── 方式 1: SFTP 虚拟文件系统遍历 ──
  console.log('\n───────────────────────────────────────────────────────')
  console.log('  方式 1: SFTP 虚拟文件系统遍历')
  console.log('───────────────────────────────────────────────────────\n')

  const conn = new SSHClient()

  const connectConfig = {
    host: opts.host,
    port: opts.port,
    username: opts.user,
    readyTimeout: 30000,
    keepaliveInterval: 1000,
    keepaliveCountMax: 5
  }

  if (opts.privateKey) {
    const fs = await import('node:fs/promises')
    connectConfig.privateKey = await fs.readFile(opts.privateKey)
    if (opts.passphrase) connectConfig.passphrase = opts.passphrase
  } else {
    connectConfig.password = opts.password
    connectConfig.tryKeyboard = true
  }

  console.log(`连接 ${opts.host}:${opts.port} ...`)

  // 键盘交互（MFA）处理
  if (opts.password) {
    conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      // 对所有提示都回复密码（适用于密码认证和部分 MFA 场景）
      const responses = prompts.map(() => opts.password)
      finish(responses)
    })
  }

  return new Promise((resolve) => {
    let settled = false
    const done = (code) => {
      if (settled) return
      settled = true
      conn.end()
      process.exit(code)
    }

    conn.on('ready', () => {
      console.log('SSH 连接成功，打开 SFTP 通道...\n')

      conn.sftp((err, sftp) => {
        if (err || !sftp) {
          console.error(`SFTP 打开失败: ${err?.message || 'unknown'}`)
          done(1)
          return
        }

        // 先列出根目录
        sftp.readdir('/', async (rdErr, rootEntries) => {
          if (rdErr) {
            console.error(`读取根目录失败: ${rdErr.message}`)
            done(1)
            return
          }

          console.log('根目录 / 内容:')
          for (const ent of rootEntries) {
            const type = isDirEntry(ent) ? '[DIR] ' : '[FILE]'
            console.log(`  ${type} ${ent.filename}`)
          }
          console.log()

          // 递归遍历
          const startTime = Date.now()
          try {
            const results = await exploreSftpTree(sftp, '/', opts.maxDepth, opts.readdirTimeout, opts.asset)
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

            console.log('\n═══════════════════════════════════════════════════════')
            console.log('  遍历结果汇总')
            console.log('═══════════════════════════════════════════════════════')
            console.log(`耗时: ${elapsed}s`)
            console.log(`遍历目录数: ${results.totalDirs}`)
            console.log(`readdir 调用数: ${results.totalReaddirs}`)
            console.log(`错误数: ${results.errors.length}`)
            console.log()

            // 打印找到的 home 目录
            console.log(`找到的 HOME 目录 (${results.homeDirs.length} 个):`)
            for (const h of results.homeDirs) {
              console.log(`  ${h.path}`)
              console.log(`    -> 父级树: /${h.parentTree}`)
              console.log(`    -> 用户: ${h.username}`)
            }

            // 打印资产匹配
            if (results.assetPaths.length > 0) {
              console.log(`\n资产匹配 (${results.assetPaths.length} 个):`)
              for (const a of results.assetPaths) {
                console.log(`  ${a.name}: ${a.path} (depth=${a.depth})`)
                console.log(`    -> 父级树: /${a.parentTree}`)
              }
            }

            // 打印错误
            if (results.errors.length > 0) {
              console.log(`\n错误详情 (${results.errors.length} 个):`)
              for (const e of results.errors.slice(0, 20)) {
                console.log(`  ${e.dir}: ${e.error}`)
              }
              if (results.errors.length > 20) {
                console.log(`  ... 还有 ${results.errors.length - 20} 个错误`)
              }
            }

            // 总结建议
            console.log('\n═══════════════════════════════════════════════════════')
            console.log('  分析建议')
            console.log('═══════════════════════════════════════════════════════')
            if (results.homeDirs.length > 0) {
              console.log('✓ SFTP 虚拟文件系统中的资产 HOME 路径可以被遍历获取。')
              console.log('  建议在应用中将此路径缓存，避免每次连接都递归搜索。')
              console.log('\n  推荐优化方案:')
              console.log('  1. 首次连接时遍历并缓存路径到本地 DB')
              console.log('  2. 后续连接直接使用缓存路径验证 (readdir)')
              console.log('  3. 验证失败时再回退到递归搜索')
            } else {
              console.log('✗ 未找到任何 home 目录，可能原因:')
              console.log('  1. SFTP 端口不正确（应使用 JumpServer SFTP 端口，通常为 2222）')
              console.log('  2. 用户没有资产访问权限')
              console.log('  3. 目录深度超过限制（可用 --max-depth 增加）')
              console.log('  4. JumpServer 版本不兼容的虚拟文件系统结构')
            }

            if (opts.apiUrl && opts.apiToken) {
              console.log('\n  另外建议:')
              console.log('  如果 REST API 能返回 nodes 字段，可直接构建路径，')
              console.log('  无需 SFTP 遍历，速度更快更可靠。')
            }

            console.log('═══════════════════════════════════════════════════════\n')

            done(0)
          } catch (err) {
            console.error(`遍历失败: ${err.message}`)
            done(1)
          }
        })
      })
    })

    conn.on('error', (err) => {
      console.error(`\nSSH 连接错误: ${err.message}`)
      console.error('可能原因:')
      console.error('  1. 主机或端口不正确')
      console.error('  2. 认证失败（密码/密钥错误）')
      console.error('  3. 需要通过 MFA 认证（SFTP 不支持交互式 MFA）')
      console.error('  4. 网络不通或防火墙拦截')
      done(1)
    })

    conn.on('close', () => {
      if (!settled) {
        console.log('SSH 连接已关闭')
        done(1)
      }
    })

    conn.connect(connectConfig)
  })
}

main().catch((err) => {
  console.error('未捕获错误:', err)
  process.exit(1)
})
