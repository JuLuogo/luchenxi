<script setup lang="ts">
/**
 * 设置 · AI 润色（公开课评语的可选增强）
 *
 * **默认关闭**。开启后公开课评价页会出现「AI 润色」按钮 ——
 * 它只把规则评语改得更顺口，**不做任何判断**（事实来自规则评语，见 docs/15 §3）。
 *
 * 密钥只存本机 `localStorage`，**不进 state** —— state 会广播给大屏与学生端，
 * 放进去等于把 API Key 发给全教室。
 */
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { loadAiConfig, saveAiConfig, type AiPolishConfig } from '../../../shared/ai-polish';

const cfg = ref<AiPolishConfig>(loadAiConfig());

function save() {
  saveAiConfig({
    enabled: !!cfg.value.enabled,
    endpoint: String(cfg.value.endpoint || '').trim(),
    apiKey: String(cfg.value.apiKey || '').trim(),
    model: String(cfg.value.model || '').trim() || 'gpt-4o-mini'
  });
  ElMessage.success('已保存（只存在这台机器上）');
}

function clear() {
  cfg.value = { enabled: false, endpoint: '', apiKey: '', model: 'gpt-4o-mini' };
  save();
  ElMessage.info('已关闭 AI 润色');
}
</script>

<template>
  <div class="ai-page">
    <h2>AI 润色（可选）</h2>
    <el-alert type="info" :closable="false" show-icon class="note">
      <template #title>它是润色器，不是评委</template>
      <div class="note-body">
        公开课评语默认由规则生成（离线可用、不会编造）。开启 AI 后，它只把这句话改得更顺口：
        事实全部来自规则评语，提示词明确要求"<b>只能改写措辞，不得新增任何判断</b>"。
        <br />
        原因：Kluger &amp; DeNisi (1996) 的元分析显示 &gt;38% 的反馈干预让表现变差，
        其中危害最大的是<b>判断错误</b>的反馈 —— 而模型最擅长生成"听起来很对"的话。
      </div>
    </el-alert>

    <el-form label-width="120px" class="form">
      <el-form-item label="启用">
        <el-switch v-model="cfg.enabled" />
        <span class="hint">关闭时公开课页面不出现「AI 润色」按钮</span>
      </el-form-item>
      <el-form-item label="接口地址">
        <el-input v-model="cfg.endpoint" placeholder="https://api.example.com/v1/chat/completions" />
        <span class="hint">OpenAI 兼容的 chat/completions 地址</span>
      </el-form-item>
      <el-form-item label="API Key">
        <el-input v-model="cfg.apiKey" type="password" show-password placeholder="sk-…" />
        <span class="hint">只存在这台机器的浏览器里，不上传、不同步</span>
      </el-form-item>
      <el-form-item label="模型">
        <el-input v-model="cfg.model" placeholder="gpt-4o-mini" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="save">保存</el-button>
        <el-button @click="clear">关闭并清除</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>

<style scoped>
.ai-page { max-width: 760px; }
.note { margin-bottom: var(--sp-4); }
.note-body { font-size: var(--fs-sm); line-height: 1.7; }
.form { margin-top: var(--sp-2); }
.hint { margin-left: var(--sp-2); color: var(--el-text-color-secondary); font-size: var(--fs-xs); }
</style>
