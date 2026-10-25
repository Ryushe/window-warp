//! A temporary hook also handles Windows-reserved Super+X/C. It is installed
//! only after a successful push, on its own message thread, and removed on
//! consumption, expiry, pause or process exit. No keyboard data is retained.
use std::{ptr::null_mut, sync::mpsc, thread::JoinHandle};
use tauri::AppHandle;
use windows_sys::Win32::{
    Foundation::*,
    System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
    UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};

unsafe extern "system" fn keyboard(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && (wp as u32 == WM_KEYDOWN || wp as u32 == WM_SYSKEYDOWN) {
        let event = &*(lp as *const KBDLLHOOKSTRUCT);
        if (event.vkCode == 88 || event.vkCode == 67)
            && [VK_CONTROL, VK_MENU, VK_SHIFT]
                .iter()
                .all(|key| GetAsyncKeyState(i32::from(*key)) >= 0)
        {
            let meta = GetAsyncKeyState(i32::from(VK_LWIN)) < 0
                || GetAsyncKeyState(i32::from(VK_RWIN)) < 0;
            let key = match (meta, event.vkCode) {
                (true, 88) => "Super+X",
                (true, _) => "Super+C",
                (false, 88) => "X",
                (false, _) => "C",
            };
            if crate::retile::fire(key) {
                if meta {
                    // A consumed Win chord must not turn Win release into a
                    // standalone Start-menu press. Ctrl was verified up above.
                    let inputs = [0, KEYEVENTF_KEYUP].map(|flags| INPUT {
                        r#type: INPUT_KEYBOARD,
                        Anonymous: INPUT_0 {
                            ki: KEYBDINPUT {
                                wVk: VK_CONTROL,
                                dwFlags: flags,
                                ..std::mem::zeroed()
                            },
                        },
                    });
                    SendInput(2, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
                }
                return 1;
            }
        }
    }
    CallNextHookEx(null_mut(), code, wp, lp)
}
#[derive(Default)]
pub struct RetileHooks {
    thread: Option<(u32, JoinHandle<Result<(), String>>)>,
}
impl RetileHooks {
    pub fn install(&mut self, _: &AppHandle, _: &[String]) -> Result<(), String> {
        self.install_native()
    }
    pub(crate) fn install_native(&mut self) -> Result<(), String> {
        let (ready, result) = mpsc::sync_channel(1);
        let thread = std::thread::Builder::new()
            .name("retile-key-hook".into())
            .spawn(move || unsafe {
                let mut message: MSG = std::mem::zeroed();
                PeekMessageW(&mut message, null_mut(), 0, 0, PM_NOREMOVE);
                let hook = SetWindowsHookExW(
                    WH_KEYBOARD_LL,
                    Some(keyboard),
                    GetModuleHandleW(std::ptr::null()),
                    0,
                );
                if hook.is_null() {
                    let error = super::error("Cannot capture temporary X/C keys");
                    let _ = ready.send(Err(error.clone()));
                    return Err(error);
                }
                let _ = ready.send(Ok(GetCurrentThreadId()));
                let result = loop {
                    match GetMessageW(&mut message, null_mut(), 0, 0) {
                        0 => break Ok(()),
                        -1 => break Err(super::error("Retile keyboard message loop failed")),
                        _ => {
                            TranslateMessage(&message);
                            DispatchMessageW(&message);
                        }
                    }
                };
                if UnhookWindowsHookEx(hook) == 0 {
                    return Err(super::error("Cannot release temporary X/C keys"));
                }
                result
            })
            .map_err(|e| e.to_string())?;
        match result
            .recv()
            .map_err(|_| "Retile keyboard thread stopped before startup.")?
        {
            Ok(id) => {
                self.thread = Some((id, thread));
                Ok(())
            }
            Err(error) => {
                let _ = thread.join();
                Err(error)
            }
        }
    }
    pub fn clear(&mut self, _: &AppHandle) -> Result<(), String> {
        self.stop()
    }
    pub(crate) fn stop(&mut self) -> Result<(), String> {
        if let Some((id, thread)) = self.thread.as_ref() {
            if !thread.is_finished() && unsafe { PostThreadMessageW(*id, WM_QUIT, 0, 0) } == 0 {
                return Err(super::error("Cannot stop temporary X/C capture"));
            }
        }
        if let Some((_, thread)) = self.thread.take() {
            thread
                .join()
                .map_err(|_| "Retile keyboard thread failed.")??;
        }
        Ok(())
    }
}
impl Drop for RetileHooks {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
