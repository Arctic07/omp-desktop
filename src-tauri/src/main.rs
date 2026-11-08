// A release build is a GUI application: without this the console subsystem is the one Windows
// attaches, and double-clicking the executable opens a console window behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    omp_desktop_lib::run();
}
