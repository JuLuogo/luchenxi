<script setup lang="ts">
/**
 * 系统设置 · 房间与大屏
 * 房间号决定"谁能看到谁"；学生端地址与二维码都在这里集中管理（旧版散在课堂协同页顶部）。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { CI } from '../../../shared/bridge';

const roomInput = ref(CI.sync.room());
const info = ref(CI.sync.serverInfo());
const qrFailed = ref(false);

/** 新窗口打开大屏：模板作用域里拿不到 window，必须走 setup 函数 */
function openStage(): void {
  window.open(stageUrl.value, '_blank');
}

const studentUrl = computed(() => {
  try { return CI.sync.joinURL(window.location.origin); } catch (e) { return ''; }
});
const qrUrl = computed(() => {
  try { return CI.sync.qrURL(studentUrl.value); } catch (e) { return ''; }
});
const stageUrl = computed(() => window.location.origin + '/stage?room=' + encodeURIComponent(roomInput.value || 'default'));

onMounted(() => { info.value = CI.sync.serverInfo(); });

function saveRoom() {
  const clean = CI.sync.setRoom(roomInput.value);
  roomInput.value = clean;
  ElMessage.success('已切换到房间 ' + clean + '（页面会自动重连）');
}

async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); ElMessage.success(label + '已复制'); }
  catch (e) { ElMessage.warning('复制失败，请手动选中'); }
}

const addresses = computed(() => {
  const list = (info.value && info.value.addresses) || [];
  return list.length ? list : [];
});
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2>房间与大屏</h2>
        <div class="desc">同一房间号的学生端 / 大屏才能看到这份课堂数据；换房间等于换一个"教室"。</div>
      </div>
      <div class="actions">
        <el-button @click="copy(stageUrl, '大屏地址')">复制大屏地址</el-button>
        <el-button type="primary" @click="openStage()">打开大屏</el-button>
      </div>
    </div>

    <el-row :gutter="14">
      <el-col :xs="24" :md="14">
        <div class="panel">
          <h3 class="panel-title">房间号</h3>
          <el-space>
            <el-input v-model="roomInput" style="width: 240px" placeholder="例如 class-3f" />
            <el-button type="primary" @click="saveRoom">保存并重连</el-button>
          </el-space>
          <div class="hint">
            只允许字母、数字、下划线与短横线；保存后教师端、学生端、大屏三端都会切到这个房间。
          </div>

          <h3 class="panel-title" style="margin-top: 20px">学生端地址</h3>
          <el-space wrap>
            <el-input :model-value="studentUrl" readonly style="width: 420px" />
            <el-button @click="copy(studentUrl, '学生端地址')">复制</el-button>
          </el-space>
          <div class="hint">学生手机浏览器直接打开即可（无需安装）；客户端同样支持这个地址。</div>

          <div v-if="addresses.length" class="hint" style="margin-top: 12px">
            本机其它地址（多网卡 / EasyTier 虚拟 IP 时学生端可改用其一）：
            <div v-for="a in addresses" :key="a" class="addr">{{ a }}</div>
          </div>
        </div>
      </el-col>

      <el-col :xs="24" :md="10">
        <div class="panel qr-panel">
          <h3 class="panel-title">扫码入座</h3>
          <img v-if="qrUrl && !qrFailed" :src="qrUrl" class="qr" alt="学生端二维码" @error="qrFailed = true" />
          <div v-else class="qr-fallback">
            <div class="fb-title">二维码不可用</div>
            <div class="fb-desc">
              桌面客户端内置枢纽不提供二维码图片，请把上面的学生端地址<b>发到班级群</b>或让学生手输；
              或者用教室电脑打开大屏，学生按地址访问。
            </div>
          </div>
          <div class="hint">大屏：{{ stageUrl }}</div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.hint { color: var(--ci-text-weak); font-size: 12px; margin-top: 10px; }
.addr { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: #334155; }
.qr-panel { text-align: center; }
.qr { width: 220px; height: 220px; image-rendering: pixelated; }
.qr-fallback { border: 1px dashed var(--ci-line); border-radius: 10px; padding: 18px; background: #fbfbfd; }
.fb-title { font-weight: 600; margin-bottom: 6px; }
.fb-desc { color: var(--ci-text-weak); font-size: 12px; line-height: 1.8; text-align: left; }
</style>
