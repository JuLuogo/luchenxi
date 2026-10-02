/**
 * 学生端领域层桥接：直接复用 assets/js/student.js（连接 / 入座 / 提交 / 抢答 / 快照解析）。
 *
 * 该模块原本只给旧 student.html 用：DOM 元素在时它会自动渲染，新版（Vue）界面里没有那些元素，
 * 所以它只在 `#sHead` 存在时才自动初始化，我们就可以自己调用 `CIStudent.init()` 并订阅状态。
 */
import '@domain/student.js';

export const CIStudent = globalThis.CIStudent;

export default CIStudent;
