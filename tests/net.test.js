/*!
 * tests/net.test.js — EasyTier 组网参数拼装校验（Rust 侧 net.rs 的等价实现）
 *   node tests/net.test.js
 *
 * 为什么要有这个测试：Rust 代码在 CI 才能编译，而"参数拼错"这类问题编译期发现不了，
 * 只会表现为"连不上网"。这里用同一份规则表校验各场景生成的命令行，
 * 并断言 Rust 源文件里确实出现了这些参数（两端不漂移）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function ok(cond, label) { if (cond) passed++; else failures.push(label); }
function eq(a, b, label) { if (JSON.stringify(a) === JSON.stringify(b)) passed++; else failures.push(label + '  →  期望 ' + JSON.stringify(b) + '\n        实际 ' + JSON.stringify(a)); }
function group(n) { console.log('\n== ' + n + ' =='); }

/** 与 crates/ci-core/src/net.rs 的 build_args 一一对应的 JS 版本 */
function buildArgs(cfg) {
  const args = [];
  if (cfg.virtual_ip && cfg.virtual_ip.trim()) { args.push('-i'); args.push(cfg.virtual_ip.trim()); }
  else args.push('-d');

  args.push('--network-name'); args.push(cfg.network_name);
  args.push('--network-secret'); args.push(cfg.network_secret);

  (cfg.peers || []).forEach((p) => { if (p && p.trim()) { args.push('-p'); args.push(p.trim()); } });
  if (cfg.listen_port) { args.push('-l'); args.push(String(cfg.listen_port)); }

  if (cfg.config_server && cfg.config_server.trim()) { args.push('--config-server'); args.push(cfg.config_server.trim()); }
  else if (cfg.username && cfg.username.trim()) { args.push('-w'); args.push(cfg.username.trim()); }

  if (cfg.no_tun) args.push('--no-tun');
  return args;
}

const base = { network_name: 'class-3f', network_secret: 's3cret', peers: [] };

/* ================= 1. 基础组网 ================= */
group('基础组网（共享节点 + DHCP）');
eq(buildArgs(Object.assign({}, base, { peers: ['tcp://public.easytier.cn:11010'] })),
  ['-d', '--network-name', 'class-3f', '--network-secret', 's3cret', '-p', 'tcp://public.easytier.cn:11010'],
  '教师机 DHCP 模式 + 官方共享节点');

eq(buildArgs(Object.assign({}, base, { virtual_ip: '10.144.144.1' })),
  ['-i', '10.144.144.1', '--network-name', 'class-3f', '--network-secret', 's3cret'],
  '固定虚拟 IP（教师机常做锚点）');

/* ================= 2. 多共享节点与去中心化 ================= */
group('多共享节点 / 去中心化');
const multi = buildArgs(Object.assign({}, base, { peers: ['tcp://a:11010', 'udp://b:11011', '', '  '] }));
eq(multi.filter((x) => x === '-p').length, 2, '两个有效 -p（空串被忽略）');
ok(multi.indexOf('tcp://a:11010') > 0 && multi.indexOf('udp://b:11011') > 0, '两个共享节点都在参数里');

const direct = buildArgs(Object.assign({}, base, { virtual_ip: '10.9.9.2', peers: ['tcp://10.9.9.1:11010'] }));
ok(direct.indexOf('-p') > 0 && direct.indexOf('tcp://10.9.9.1:11010') > 0, '去中心化：只连对端节点');

/* ================= 3. 监听端口（多开） ================= */
group('监听端口');
eq(buildArgs(Object.assign({}, base, { listen_port: 21010 })).slice(-2), ['-l', '21010'], '指定监听端口避免冲突');

/* ================= 4. 第三方配置服务器 / Web 控制台托管 ================= */
group('配置服务器（用户提到的"第三方组网工具"能力）');
const cs = buildArgs(Object.assign({}, base, { config_server: 'https://easytier.example.com' }));
eq(cs[cs.length - 2], '--config-server', '--config-server 位置正确');
eq(cs[cs.length - 1], 'https://easytier.example.com', '--config-server 取值正确');
ok(cs.indexOf('-w') < 0, '给了 config-server 就不再传 -w');

const w = buildArgs(Object.assign({}, base, { username: 'teacher01' }));
eq(w.slice(-2), ['-w', 'teacher01'], '只给用户名时用 -w（官方 Web 控制台）');

const both = buildArgs(Object.assign({}, base, { config_server: 'https://x', username: 'teacher01' }));
ok(both.indexOf('--config-server') > 0 && both.indexOf('-w') < 0, '两者都给时以 config-server 优先');

/* ================= 5. 无 TUN 模式 ================= */
group('免 Root / 免管理员');
const noTun = buildArgs(Object.assign({}, base, { no_tun: true }));
eq(noTun[noTun.length - 1], '--no-tun', '无 TUN 模式追加 --no-tun');

/* ================= 6. 与 Rust 源码不漂移 ================= */
group('与 Rust 源码一致性（net.rs）');
// v5 起 net.rs 在 crates/ci-core（原先在 apps/teacher/src-tauri/src）
const net = fs.readFileSync(path.join(ROOT, 'crates', 'ci-core', 'src', 'net.rs'), 'utf8');
['-i', '-d', '--network-name', '--network-secret', '-p', '-l', '--config-server', '-w', '--no-tun'].forEach((flag) => {
  ok(net.indexOf('"' + flag + '"') >= 0, 'net.rs 含参数 ' + flag);
});
ok(net.indexOf('build_args') >= 0, 'net.rs 暴露 build_args（便于展示与排障）');
ok(/pub async fn start/.test(net) && /pub async fn stop/.test(net) && /pub async fn status/.test(net), 'net.rs 提供 start/stop/status');
ok(net.indexOf('easytier-core') >= 0 && net.indexOf('easytier-cli') >= 0, 'net.rs 通过 sidecar 名调用两个二进制');

// 与文档里的说法对齐：Android 不内置 CLI
const docs11 = fs.readFileSync(path.join(ROOT, 'docs', '11-跨平台客户端与数据库方案.md'), 'utf8');
ok(/Android[\s\S]{0,200}没有 CLI/.test(docs11) || /没有 CLI 版/.test(docs11), 'docs/11 明确说明 Android 无 CLI（不内置）');

/* ================= 7. 前端组网模块（net.js）与 Rust 同规则 ================= */
group('前端 net.js：命令预览与 Rust 一致');

const vm = require('vm');
const netJsSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'net.js'), 'utf8');
const storeMap = new Map();
const win = {
  location: { protocol: 'http:', host: 'localhost:8080' },
  localStorage: {
    getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
    setItem: (k, v) => storeMap.set(k, String(v)),
    removeItem: (k) => storeMap.delete(k)
  },
  document: { getElementById: () => null },
  navigator: {}, alert: () => {}
};
const ctx = vm.createContext(Object.assign(win, { window: win, globalThis: win, console: console }));
win.CI = ctx.CI = { storage: { inTauri: () => false } };
vm.runInContext(netJsSrc, ctx);
const NET = ctx.CI.net;

ok(!!NET, 'net.js 挂载 CI.net');
['render', 'start', 'stop', 'refresh', 'copyCmd', 'buildArgs', 'cmdline', 'guidance', 'inClient'].forEach((fn) => {
  ok(typeof NET[fn] === 'function', 'CI.net 暴露 ' + fn);
});
ok(NET.inClient() === false, '浏览器环境识别为非客户端');

// 同一份配置下，前端 JS 与 Rust 规则表必须生成同样的参数
const cases = [
  Object.assign({}, base, { peers: ['tcp://public.easytier.cn:11010'] }),
  Object.assign({}, base, { virtual_ip: '10.144.144.1' }),
  Object.assign({}, base, { virtual_ip: '10.9.9.2', peers: ['tcp://10.9.9.1:11010'], listen_port: '21010' }),
  Object.assign({}, base, { config_server: 'https://easytier.example.com' }),
  Object.assign({}, base, { username: 'teacher01', no_tun: true })
];
cases.forEach((c, i) => {
  eq(NET.buildArgs(c), buildArgs(c), '前端与 Rust 规则一致（用例 ' + (i + 1) + '）');
});
ok(NET.cmdline(Object.assign({}, base, { peers: ['tcp://public.easytier.cn:11010'] })).indexOf('easytier-core ') === 0, 'cmdline 以 easytier-core 开头');

const guide = NET.guidance('10.144.144.1:8080');
ok(guide.indexOf('EasyTier 官方 App') >= 0 && guide.indexOf('10.144.144.1:8080') >= 0, '组网引导含官方 App 与虚拟 IP 示例');
ok(guide.indexOf('同一个 WiFi') >= 0, '组网引导首推局域网直连');

// 教师端页面确实挂了面板容器与脚本
const adminHtml = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
ok(adminHtml.indexOf('id="classNet"') >= 0, 'admin.html 有组网面板容器 classNet');
ok(adminHtml.indexOf('assets/js/net.js') >= 0, 'admin.html 引入 net.js');

// 学生端提供手填地址与引导
const studentHtmlJs = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'student.js'), 'utf8');
['saveHost', 'testHub', 'showGuide', 'guidance', 'inTauri', 'check_hub'].forEach((k) => {
  ok(studentHtmlJs.indexOf(k) >= 0, 'student.js 含 ' + k + '（客户端连接教师机）');
});

/* ================= 8. 学生端"手输教师机地址"解析：JS ↔ Rust 双实现一致 ================= */
group('学生端地址解析（student.js ↔ student/lib.rs）');

// 与 Rust 侧 normalize() 共用同一组用例：两边结果必须逐字相同
const ADDR_CASES = [
  ['192.168.1.20:8080', 'http://192.168.1.20:8080'],
  ['192.168.1.20', 'http://192.168.1.20:8080'],
  ['http://192.168.1.20:9000', 'http://192.168.1.20:9000'],
  ['https://10.144.144.1', 'https://10.144.144.1:8080'],
  ['http://192.168.1.20:8080/join?room=c3', 'http://192.168.1.20:8080'],
  ['  10.0.0.5:8080  ', 'http://10.0.0.5:8080'],
  ['', ''],
  ['   ', '']
];

// JS 版：与 student.js 的 hubHost()/hubURL() 同规则（缺端口补 8080 —— 这里曾漏掉，被本测试抓出）
function jsNormalize(input) {
  var raw = String(input || '').trim();
  if (!raw) return '';
  var scheme = /^https:\/\//i.test(raw) ? 'https://' : 'http://';
  var h = raw.replace(/^wss?:\/\//i, '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (h && h.indexOf(':') < 0) h += ':8080';
  return h ? scheme + h : '';
}

ADDR_CASES.forEach(([input, want]) => {
  eq(jsNormalize(input), want, '地址解析：' + JSON.stringify(input));
});

// 规则必须与源码里的实现对应（防漂移）
const studentSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'student.js'), 'utf8');
ok(/function hubHostRaw\(/.test(studentSrc), 'student.js 有 hubHostRaw()');
ok(/function hubHost\(/.test(studentSrc), 'student.js 有 hubHost()');
ok(/function setHubHost\(/.test(studentSrc), 'student.js 有 setHubHost()');
ok(/replace\(\/\^https\?:\\\/\\\/\/i, ''\)/.test(studentSrc), 'student.js 去掉协议头');
ok(/replace\(\/\\\/\.\*\$\/, ''\)/.test(studentSrc), 'student.js 去掉路径');

// Rust 侧：同一组用例必须写在 lib.rs 的单元测试里（CI 编译后执行）
const studentLib = fs.readFileSync(path.join(ROOT, 'apps', 'student', 'src-tauri', 'src', 'lib.rs'), 'utf8');
ok(/fn normalize_matches_js_rules/.test(studentLib), 'student/lib.rs 有一致性单测');
ADDR_CASES.filter(([i]) => i.trim()).forEach(([input]) => {
  ok(studentLib.indexOf('"' + input.trim() + '"') >= 0 || studentLib.indexOf(input) >= 0,
    'Rust 单测含同一用例：' + JSON.stringify(input));
});
ok(/fn run\(\)/.test(studentLib), 'student/lib.rs 提供 run()');
ok(/tauri::generate_handler!\[check_hub\]/.test(studentLib), 'check_hub 命令注册在 lib 里');
ok(fs.readFileSync(path.join(ROOT, 'apps', 'student', 'src-tauri', 'src', 'main.rs'), 'utf8')
  .indexOf('luchenxi_student_lib::run()') >= 0, 'main.rs 是薄壳，调用 lib 的 run()');

/* ================= 收尾 ================= */
console.log('\n----------------------------------------');
if (failures.length) {
  console.log(`❌ 失败 ${failures.length} 项 / 通过 ${passed} 项`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
} else {
  console.log(`✅ 全部通过：${passed} 项断言`);
}
