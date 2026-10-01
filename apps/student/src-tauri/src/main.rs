//! 桌面端薄壳：与移动端（Android/iOS）共用 `luchenxi_student_lib::run()`
//!
//! 真正的实现在 lib.rs —— Tauri v2 的移动端工程只能调用 lib target，
//! 所以业务代码一律放库里，main.rs 只负责桌面端入口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    luchenxi_student_lib::run()
}
