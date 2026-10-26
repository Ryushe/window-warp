//! Retile used to install its own low-level hook. That hook ran first and let
//! Windows see Win chords before Warp could swallow them. X/C now go through
//! the single hook in windows_reserved.rs, which calls retile::fire.
use tauri::AppHandle;

#[derive(Default)]
pub struct RetileHooks {
    testing: bool,
}
impl RetileHooks {
    pub fn install(&mut self, _: &AppHandle, _: &[String]) -> Result<(), String> {
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn install_native(&mut self) -> Result<(), String> {
        self.testing = true;
        super::reserved::install_shared()
    }
    pub fn clear(&mut self, _: &AppHandle) -> Result<(), String> {
        Ok(())
    }
    pub(crate) fn stop(&mut self) -> Result<(), String> {
        if self.testing {
            self.testing = false;
            super::reserved::uninstall_shared()?;
        }
        Ok(())
    }
}
impl Drop for RetileHooks {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
