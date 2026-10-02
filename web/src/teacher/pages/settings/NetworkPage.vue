<script setup lang="ts">
/**
 * 系统设置 · 组网（EasyTier）
 * 配置持久化与命令行拼装直接用 CI.net（与 Rust 侧参数表一致，已被 75 项测试覆盖）；
 * 启停走 invoke('net_start'/'net_stop')，浏览器里只给命令预览与引导。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { CI } from '../../../shared/bridge';

const form = ref(CI.net.cfg());
const runtime = ref({ running: false, busy: false, error: '', lastArgs: [] });
const inClient = ref(CI.net.inClient());
const check = ref<any>(null);

function persist() {
  form.value = CI.net.saveCfg({ ...form.value });
}

const cmd = computed(() => CI.net.cmdline(persistValue()));

function persistValue() {
  // buildArgs/cmdline 是纯函数：传当前表单值即可，不产生副作用
  return { ...CI.net.cfg(), ...form.value };
}

async function refresh() {
  if (!inClient.value) return;
  try {
    const st = await CI.storage.invoke('net_status', {});
    runtime.value = { ...runtime.value, ...(st || {}), busy: false };
  } catch (e) {
    runtime.value = { ...runtime.value, error: e && e.message ? e.message : String(e), busy: false };
  }
}

onMounted(refresh);

async function start() {
  persist();
  if (!form.value.network_name) { ElMessage.error('请先填写网络名'); return; }
  if (!inClient.value) {
    ElMessage.info('浏览器里不能直接组建虚拟网：请复制命令到终端执行，或使用桌面客户端');
    return;
  }
  runtime.value = { ...runtime.value, busy: true, error: '' };
  try {
    const res = await CI.storage.invoke('net_start', { cfg: form.value });
    runtime.value = { ...runtime.value, busy: false, running: !!(res && res.ok), lastArgs: (res && res.args) || [] };
    ElMessage.success('组网命令已启动');
    refresh();
  } catch (e) {
    runtime.value = { ...runtime.value, busy: false, error: e && e.message ? e.message : String(e) };
    ElMessage.error('启动失败：' + runtime.value.error);
  }
}

async function stop() {
  if (!inClient.value) { ElMessage.info('浏览器里没有可停止的 EasyTier 进程'); return; }
  runtime.value = { ...runtime.value, busy: true };
  try {
    await CI.storage.invoke('net_stop', {});
    runtime.value = { ...runtime.value, busy: false, running: false };
    ElMessage.success('已停止组网');
  } catch (e) {
    runtime.value = { ...runtime.value, busy: false, error: e && e.message ? e.message : String(e) };
  }
}

async function copyCmd() {
  try {
    await navigator.clipboard.writeText(cmd.value);
    ElMessage.success('命令已复制');
  } catch (e) { ElMessage.warning('复制失败，请手动选择'); }
}

function runCheck() {
  check.value = CI.net.selfCheck();
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2>组网（EasyTier）</h2>
        <div class="desc">
          跨网段（不同 WiFi / 手机流量）时，先组虚拟网，学生再用虚拟 IP 连教师机。
          <template v-if="!inClient">当前是浏览器环境：只能预览命令。</template>
        </div>
      </div>
      <div class="actions">
        <el-button @click="runCheck">上课前自检</el-button>
        <el-button @click="copyCmd">复制命令</el-button>
        <el-button v-if="!runtime.running" type="primary" :loading="runtime.busy" @click="start">一键组网</el-button>
        <el-button v-else type="danger" :loading="runtime.busy" @click="stop">停止组网</el-button>
      </div>
    </div>

    <el-alert
      v-if="runtime.error"
      type="error"
      show-icon
      :closable="false"
      style="margin-bottom: 14px"
      :title="'EasyTier 错误：' + runtime.error"
    />

    <el-row :gutter="14">
      <el-col :xs="24" :md="14">
        <div class="panel">
          <h3 class="panel-title">
            网络参数
            <el-tag v-if="runtime.running" type="success" size="small">运行中</el-tag>
            <el-tag v-else type="info" size="small">未启动</el-tag>
          </h3>

          <el-form label-width="110">
            <el-form-item label="网络名" required>
              <el-input v-model="form.network_name" placeholder="同一网络名才能互通，例如 class-3f" @change="persist" />
            </el-form-item>
            <el-form-item label="网络密钥">
              <el-input v-model="form.network_secret" placeholder="同一密钥才能互通（可留空）" show-password @change="persist" />
            </el-form-item>
            <el-form-item label="共享节点">
              <el-input v-model="form.peers" type="textarea" :rows="3" placeholder="每行一个，例如 tcp://public.easytier.cn:11010" @change="persist" />
            </el-form-item>
            <el-form-item label="本机虚拟 IP">
              <el-input v-model="form.ipv4" placeholder="留空自动分配，例如 10.126.126.1" style="width: 220px" @change="persist" />
            </el-form-item>
            <el-form-item label="监听端口">
              <el-input v-model="form.listeners" placeholder="例如 tcp://0.0.0.0:11010" style="width: 260px" @change="persist" />
            </el-form-item>
            <el-form-item label="配置服务器">
              <el-input v-model="form.config_server" placeholder="第三方托管（--config-server），可留空" @change="persist" />
            </el-form-item>
            <el-form-item label="无 TUN 模式">
              <el-switch v-model="form.no_tun" @change="persist" />
              <span class="hint">没有管理员权限时打开（只代理流量，不建虚拟网卡）</span>
            </el-form-item>
          </el-form>
        </div>
      </el-col>

      <el-col :xs="24" :md="10">
        <div class="panel">
          <h3 class="panel-title">将要执行的命令</h3>
          <pre class="cmd">{{ cmd }}</pre>
          <div class="hint">参数与 Rust 侧完全一致（同一套规则表，tests/net.test.js 会校验）。</div>
        </div>

        <div class="panel">
          <h3 class="panel-title">学生端怎么连</h3>
          <ol class="guide">
            <li>教师机先「一键组网」，记下本机虚拟 IP（上方填的或自动分配的）。</li>
            <li>学生手机装 <b>EasyTier 官方 App</b>，用<b>同一网络名 / 密钥</b>加入。</li>
            <li>学生端地址填 <code>http://&lt;虚拟IP&gt;:8080/join</code>（只写 IP 也行，端口会自动补 8080）。</li>
            <li>同一局域网时不必组网，直接用教室网段 IP。</li>
          </ol>
        </div>

        <div v-if="check" class="panel">
          <h3 class="panel-title">自检结果</h3>
          <el-table :data="check.items || []" size="small">
            <el-table-column prop="label" label="项" min-width="120" />
            <el-table-column label="结果" width="80">
              <template #default="{ row }">
                <el-tag :type="row.ok ? 'success' : 'warning'" size="small">{{ row.ok ? '通过' : '注意' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="hint" label="说明" min-width="160" show-overflow-tooltip />
          </el-table>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.cmd {
  background: #0f172a;
  color: #e2e8f0;
  border-radius: 10px;
  padding: 12px;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}
.hint { color: var(--ci-text-weak); font-size: 12px; margin-top: 10px; }
.guide { color: var(--ci-text); font-size: 13px; line-height: 2; padding-left: 18px; margin: 0; }
.guide code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; }
</style>
