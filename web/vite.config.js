import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

/**
 * 三个入口一次构建（输出文件名**刻意保持旧约定**，这样三端 URL 不变）：
 *   admin.html   → 教师端（/admin.html）
 *   student.html → 学生端（/join、/student.html）
 *   index.html   → 教室大屏（/stage、/index.html）
 *
 * base 用相对路径：Tauri 里页面来自 asset 协议，绝对路径 /assets/... 会解析错。
 * 哈希路由同理（自定义协议下 history 路由刷新即 404）。
 */
export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@domain': fileURLToPath(new URL('../assets/js', import.meta.url))
    }
  },
  server: {
    port: 5173,
    // 开发时把枢纽接口代理到本机 8080，避免跨域与两套地址
    proxy: {
      '/health': 'http://127.0.0.1:8080',
      '/api': 'http://127.0.0.1:8080',
      '/qr.png': 'http://127.0.0.1:8080'
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
        student: fileURLToPath(new URL('./student.html', import.meta.url)),
        stage: fileURLToPath(new URL('./index.html', import.meta.url))
      }
    }
  }
});
