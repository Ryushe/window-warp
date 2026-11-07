//! Windows 10's virtual-desktop shell interfaces.
//!
//! Windows exposes no public API to switch desktops or move another process's
//! windows. These interfaces are specific to Windows 10 1809–22H2 and must
//! never be used for Windows 11. References: the Windows 10 implementations in
//! https://github.com/MScholtes/VirtualDesktop and
//! https://github.com/Ciantic/VirtualDesktopAccessor (winvd 0.0.20).

use std::{ffi::c_void, ptr::null_mut};
use windows::{
    core::{IUnknown_Vtbl, Interface, GUID, HRESULT},
    Win32::{
        Foundation::RPC_E_CHANGED_MODE,
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IServiceProvider,
            CLSCTX_ALL, CLSCTX_LOCAL_SERVER, COINIT_MULTITHREADED,
        },
        UI::Shell::{IVirtualDesktopManager, VirtualDesktopManager},
    },
};

const IMMERSIVE_SHELL: GUID = GUID::from_u128(0xc2f03a33_21f5_47fa_b4bb_156362a2f239);
const DESKTOP_MANAGER_SERVICE: GUID = GUID::from_u128(0xc5e0cdca_7b6e_41b2_9fc4_d93975cc467b);
const PINNED_APPS_SERVICE: GUID = GUID::from_u128(0xb5a399e7_1c87_46b8_88e9_fc5747b171bd);

windows::core::imp::define_interface!(
    DesktopManager,
    DesktopManagerVtable,
    0xf31574d6_b682_4cdc_bd56_1827860abec6
);
windows::core::imp::define_interface!(
    Desktop,
    DesktopVtable,
    0xff72ffdd_be7e_43fc_9c03_ad81681e88e4
);
windows::core::imp::define_interface!(
    ViewCollection,
    ViewCollectionVtable,
    0x1841c6d7_4f9d_42c0_af41_8747538f10e5
);
windows::core::imp::define_interface!(View, ViewVtable, 0x372e1d3b_38d3_42e4_a15b_8ab2b178f513);
windows::core::imp::define_interface!(
    PinnedApps,
    PinnedAppsVtable,
    0x4ce81583_1e4c_4632_a621_07a53543148f
);

// Unused slots remain pointer-sized to preserve the exact COM vtable layout.
#[repr(C)]
pub struct DesktopManagerVtable {
    base: IUnknown_Vtbl,
    get_count: usize,
    move_view: unsafe extern "system" fn(*mut c_void, *mut c_void, *mut c_void) -> HRESULT,
    can_move_view: usize,
    current: unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> HRESULT,
    get_desktops: usize,
    adjacent: usize,
    switch: unsafe extern "system" fn(*mut c_void, *mut c_void) -> HRESULT,
    create: usize,
    remove: usize,
    find: unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HRESULT,
}

#[repr(C)]
pub struct DesktopVtable {
    base: IUnknown_Vtbl,
    is_view_visible: usize,
    get_id: unsafe extern "system" fn(*mut c_void, *mut GUID) -> HRESULT,
}

#[repr(C)]
pub struct ViewCollectionVtable {
    base: IUnknown_Vtbl,
    before_get_view: [usize; 3],
    get_view: unsafe extern "system" fn(*mut c_void, isize, *mut *mut c_void) -> HRESULT,
}

#[repr(C)]
pub struct ViewVtable {
    base: IUnknown_Vtbl,
    before_get_app_id: [usize; 14],
    get_app_id: unsafe extern "system" fn(*mut c_void, *mut *mut u16) -> HRESULT,
}

#[repr(C)]
pub struct PinnedAppsVtable {
    base: IUnknown_Vtbl,
    is_app_pinned: unsafe extern "system" fn(*mut c_void, *const u16, *mut i32) -> HRESULT,
    pin_app: usize,
    unpin_app: usize,
    is_view_pinned: unsafe extern "system" fn(*mut c_void, *mut c_void, *mut i32) -> HRESULT,
}

struct Apartment(bool);
impl Apartment {
    fn new() -> Result<Self, String> {
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if result.is_ok() {
            Ok(Self(true))
        } else if result == RPC_E_CHANGED_MODE {
            Ok(Self(false))
        } else {
            Err(format!(
                "Could not initialize Windows desktop services: {result:?}"
            ))
        }
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe {
                CoUninitialize();
            }
        }
    }
}

fn shell() -> Result<IServiceProvider, String> {
    unsafe { CoCreateInstance(&IMMERSIVE_SHELL, None, CLSCTX_LOCAL_SERVER) }
        .map_err(|error| format!("Could not connect to Windows desktop services: {error}"))
}

fn service<T: Interface>(shell: &IServiceProvider, service: &GUID) -> Result<T, String> {
    unsafe { shell.QueryService(service) }
        .map_err(|error| format!("Windows desktop services are unavailable: {error}"))
}

fn desktop_manager(shell: &IServiceProvider) -> Result<DesktopManager, String> {
    service(shell, &DESKTOP_MANAGER_SERVICE)
}

fn current(manager: &DesktopManager) -> Result<Desktop, String> {
    let mut raw = null_mut();
    unsafe { (manager.vtable().current)(manager.as_raw(), &mut raw) }
        .ok()
        .map_err(|error| format!("Could not identify the current desktop: {error}"))?;
    if raw.is_null() {
        return Err("Windows did not return the current desktop.".into());
    }
    Ok(unsafe { Desktop::from_raw(raw) })
}

fn find(manager: &DesktopManager, id: &GUID) -> Result<Desktop, String> {
    let mut raw = null_mut();
    unsafe { (manager.vtable().find)(manager.as_raw(), id, &mut raw) }
        .ok()
        .map_err(|error| format!("Could not find that desktop: {error}"))?;
    if raw.is_null() {
        return Err("That desktop is no longer available.".into());
    }
    Ok(unsafe { Desktop::from_raw(raw) })
}

fn desktop_id(desktop: &Desktop) -> Result<GUID, String> {
    let mut id = GUID::zeroed();
    unsafe { (desktop.vtable().get_id)(desktop.as_raw(), &mut id) }
        .ok()
        .map_err(|error| format!("Could not identify the current desktop: {error}"))?;
    if id == GUID::zeroed() {
        return Err("Windows returned an empty desktop identity.".into());
    }
    Ok(id)
}

pub fn current_id() -> Result<GUID, String> {
    let _apartment = Apartment::new()?;
    let shell = shell()?;
    let manager = desktop_manager(&shell)?;
    desktop_id(&current(&manager)?)
}

fn switch_using(manager: &DesktopManager, id: &GUID) -> Result<(), String> {
    let desktop = find(manager, id)?;
    unsafe { (manager.vtable().switch)(manager.as_raw(), desktop.as_raw()) }
        .ok()
        .map_err(|error| format!("Windows could not switch to that desktop: {error}"))
}

pub fn switch(id: &GUID) -> Result<(), String> {
    let _apartment = Apartment::new()?;
    let shell = shell()?;
    let manager = desktop_manager(&shell)?;
    switch_using(&manager, id)
}

fn view_for_window(shell: &IServiceProvider, hwnd: usize) -> Result<View, String> {
    let collection: ViewCollection = service(shell, &ViewCollection::IID)?;
    let mut raw = null_mut();
    unsafe { (collection.vtable().get_view)(collection.as_raw(), hwnd as isize, &mut raw) }
        .ok()
        .map_err(|error| format!("Could not find the workspace window: {error}"))?;
    if raw.is_null() {
        return Err("The workspace window is no longer available.".into());
    }
    Ok(unsafe { View::from_raw(raw) })
}

fn is_pinned(shell: &IServiceProvider, view: &View) -> Result<bool, String> {
    let pinned: PinnedApps = service(shell, &PINNED_APPS_SERVICE)?;
    let mut yes = 0i32;
    unsafe { (pinned.vtable().is_view_pinned)(pinned.as_raw(), view.as_raw(), &mut yes) }
        .ok()
        .map_err(|error| {
            format!("Could not check whether the window is on every desktop: {error}")
        })?;
    if yes != 0 {
        return Ok(true);
    }
    let mut app_id: *mut u16 = null_mut();
    let result = unsafe { (view.vtable().get_app_id)(view.as_raw(), &mut app_id) };
    if !app_id.is_null() {
        let check = if result.is_ok() {
            Some(unsafe { (pinned.vtable().is_app_pinned)(pinned.as_raw(), app_id, &mut yes) })
        } else {
            None
        };
        unsafe {
            CoTaskMemFree(Some(app_id as *const c_void));
        }
        if let Some(check) = check {
            check.ok().map_err(|error| {
                format!("Could not check whether the app is on every desktop: {error}")
            })?;
        }
    }
    Ok(yes != 0)
}

fn move_view(manager: &DesktopManager, desktop: &Desktop, view: &View) -> Result<(), String> {
    unsafe { (manager.vtable().move_view)(manager.as_raw(), view.as_raw(), desktop.as_raw()) }
        .ok()
        .map_err(|error| format!("Windows could not move a workspace window: {error}"))
}

pub fn move_window(hwnd: usize, id: &GUID) -> Result<(), String> {
    let _apartment = Apartment::new()?;
    let shell = shell()?;
    let manager = desktop_manager(&shell)?;
    let desktop = find(&manager, id)?;
    let view = view_for_window(&shell, hwnd)?;
    if is_pinned(&shell, &view)? {
        return Ok(());
    }
    move_view(&manager, &desktop, &view)?;
    let public: IVirtualDesktopManager =
        unsafe { CoCreateInstance(&VirtualDesktopManager, None, CLSCTX_ALL) }
            .map_err(|error| format!("Could not verify the moved window: {error}"))?;
    let actual = unsafe { public.GetWindowDesktopId(windows::Win32::Foundation::HWND(hwnd as _)) }
        .map_err(|error| format!("Could not verify the moved window: {error}"))?;
    if actual != *id {
        return Err("Windows did not move a workspace window to the requested desktop.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[repr(C)]
    struct FakeDesktop {
        vtable: *const DesktopVtable,
        id: GUID,
    }
    #[repr(C)]
    struct FakeManager {
        vtable: *const DesktopManagerVtable,
        desktop: *mut c_void,
        switches: u32,
        moves: u32,
    }
    #[repr(C)]
    struct FakeView {
        vtable: *const ViewVtable,
    }

    unsafe extern "system" fn query(
        _: *mut c_void,
        _: *const GUID,
        _: *mut *mut c_void,
    ) -> HRESULT {
        HRESULT(0x80004002u32 as i32)
    }
    unsafe extern "system" fn addref(_: *mut c_void) -> u32 {
        1
    }
    unsafe extern "system" fn release(_: *mut c_void) -> u32 {
        1
    }
    fn unknown() -> IUnknown_Vtbl {
        IUnknown_Vtbl {
            QueryInterface: query,
            AddRef: addref,
            Release: release,
        }
    }
    unsafe extern "system" fn fake_id(this: *mut c_void, id: *mut GUID) -> HRESULT {
        *id = (*(this as *mut FakeDesktop)).id;
        HRESULT(0)
    }
    unsafe extern "system" fn fake_current(
        this: *mut c_void,
        desktop: *mut *mut c_void,
    ) -> HRESULT {
        *desktop = (*(this as *mut FakeManager)).desktop;
        HRESULT(0)
    }
    unsafe extern "system" fn fake_find(
        this: *mut c_void,
        id: *const GUID,
        desktop: *mut *mut c_void,
    ) -> HRESULT {
        let selected = (*(this as *mut FakeManager)).desktop;
        if *id != (*(selected as *mut FakeDesktop)).id {
            return HRESULT(0x80070002u32 as i32);
        }
        *desktop = selected;
        HRESULT(0)
    }
    unsafe extern "system" fn fake_switch(this: *mut c_void, desktop: *mut c_void) -> HRESULT {
        let manager = &mut *(this as *mut FakeManager);
        if desktop != manager.desktop {
            return HRESULT(0x80070057u32 as i32);
        }
        manager.switches += 1;
        HRESULT(0)
    }
    unsafe extern "system" fn fake_move(
        this: *mut c_void,
        view: *mut c_void,
        desktop: *mut c_void,
    ) -> HRESULT {
        let manager = &mut *(this as *mut FakeManager);
        if desktop != manager.desktop || view.is_null() {
            return HRESULT(0x80070057u32 as i32);
        }
        manager.moves += 1;
        HRESULT(0)
    }
    unsafe extern "system" fn fake_app_id(_: *mut c_void, _: *mut *mut u16) -> HRESULT {
        HRESULT(0)
    }

    #[test]
    fn windows_10_vtables_match_the_shell_method_positions() {
        let p = std::mem::size_of::<usize>();
        assert_eq!(std::mem::offset_of!(DesktopManagerVtable, move_view), 4 * p);
        assert_eq!(std::mem::offset_of!(DesktopManagerVtable, current), 6 * p);
        assert_eq!(std::mem::offset_of!(DesktopManagerVtable, switch), 9 * p);
        assert_eq!(std::mem::offset_of!(DesktopManagerVtable, find), 12 * p);
        assert_eq!(std::mem::offset_of!(DesktopVtable, get_id), 4 * p);
        assert_eq!(std::mem::offset_of!(ViewCollectionVtable, get_view), 6 * p);
        assert_eq!(std::mem::offset_of!(ViewVtable, get_app_id), 17 * p);
        assert_eq!(
            std::mem::offset_of!(PinnedAppsVtable, is_view_pinned),
            6 * p
        );
    }

    #[test]
    fn windows_10_desktop_calls_target_the_requested_desktop() {
        let desktop_vtable = DesktopVtable {
            base: unknown(),
            is_view_visible: 0,
            get_id: fake_id,
        };
        let manager_vtable = DesktopManagerVtable {
            base: unknown(),
            get_count: 0,
            move_view: fake_move,
            can_move_view: 0,
            current: fake_current,
            get_desktops: 0,
            adjacent: 0,
            switch: fake_switch,
            create: 0,
            remove: 0,
            find: fake_find,
        };
        let view_vtable = ViewVtable {
            base: unknown(),
            before_get_app_id: [0; 14],
            get_app_id: fake_app_id,
        };
        let id = GUID::from_u128(0x0beef001_0123_4567_89ab_cdef01234567);
        let mut raw_desktop = FakeDesktop {
            vtable: &desktop_vtable,
            id,
        };
        let mut raw_manager = FakeManager {
            vtable: &manager_vtable,
            desktop: &mut raw_desktop as *mut _ as _,
            switches: 0,
            moves: 0,
        };
        let mut raw_view = FakeView {
            vtable: &view_vtable,
        };
        let manager = unsafe { DesktopManager::from_raw(&mut raw_manager as *mut _ as _) };
        let view = unsafe { View::from_raw(&mut raw_view as *mut _ as _) };

        assert_eq!(desktop_id(&current(&manager).unwrap()).unwrap(), id);
        switch_using(&manager, &id).unwrap();
        let destination = find(&manager, &id).unwrap();
        move_view(&manager, &destination, &view).unwrap();
        assert!(switch_using(&manager, &GUID::zeroed()).is_err());
        assert_eq!((raw_manager.switches, raw_manager.moves), (1, 1));
    }
}
