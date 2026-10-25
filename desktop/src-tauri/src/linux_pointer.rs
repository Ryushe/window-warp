//! KDE pointer centering. Uses the compositor's declared desktop capability on
//! Wayland and the X server's native pointer operation on X11; no input hooks.
use crate::radial::Point;
use std::{
    os::fd::AsRawFd,
    time::{Duration, Instant},
};
use wayland_client::{
    protocol::{wl_callback, wl_registry},
    Connection, Dispatch, EventQueue, QueueHandle,
};
use wayland_protocols_plasma::fake_input::client::org_kde_kwin_fake_input::OrgKdeKwinFakeInput;

#[derive(Default)]
struct State {
    input: Option<OrgKdeKwinFakeInput>,
    synced: bool,
}
impl Dispatch<wl_registry::WlRegistry, ()> for State {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        queue: &QueueHandle<Self>,
    ) {
        if let wl_registry::Event::Global {
            name,
            interface,
            version,
        } = event
        {
            if interface == "org_kde_kwin_fake_input" && version >= 3 {
                state.input = Some(registry.bind(name, version.min(5), queue, ()));
            }
        }
    }
}
impl Dispatch<wl_callback::WlCallback, ()> for State {
    fn event(
        state: &mut Self,
        _: &wl_callback::WlCallback,
        _: wl_callback::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        state.synced = true;
    }
}
wayland_client::delegate_noop!(State: ignore OrgKdeKwinFakeInput);

fn sync(
    connection: &Connection,
    queue: &mut EventQueue<State>,
    state: &mut State,
    deadline: Instant,
) -> Result<(), String> {
    state.synced = false;
    connection.display().sync(&queue.handle(), ());
    queue
        .flush()
        .map_err(|e| format!("Cannot send the KDE pointer request: {e}"))?;
    loop {
        queue
            .dispatch_pending(state)
            .map_err(|e| format!("KDE pointer connection failed: {e}"))?;
        if state.synced {
            return Ok(());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("KDE did not finish the pointer request within two seconds.".into());
        }
        let Some(guard) = queue.prepare_read() else {
            continue;
        };
        let mut fd = libc::pollfd {
            fd: guard.connection_fd().as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // The guard retains the socket for the entire bounded poll/read.
        let ready = unsafe { libc::poll(&mut fd, 1, remaining.as_millis().max(1) as i32) };
        if ready < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(format!("Cannot wait for the KDE pointer response: {error}"));
        }
        if ready > 0 {
            guard
                .read()
                .map_err(|e| format!("Cannot read the KDE pointer response: {e}"))?;
        }
    }
}

pub fn move_to(point: Point) -> Result<(), String> {
    if std::env::var_os("WAYLAND_DISPLAY").is_none() {
        use x11rb::{connection::Connection as _, protocol::xproto::ConnectionExt};
        let (connection, screen) =
            x11rb::connect(None).map_err(|e| format!("Cannot connect to the X11 desktop: {e}"))?;
        let x = i16::try_from(point.x)
            .map_err(|_| "Pointer target is outside X11's coordinate range.")?;
        let y = i16::try_from(point.y)
            .map_err(|_| "Pointer target is outside X11's coordinate range.")?;
        connection
            .warp_pointer(
                0u32,
                connection.setup().roots[screen].root,
                0,
                0,
                0,
                0,
                x,
                y,
            )
            .map_err(|e| format!("Cannot center the X11 pointer: {e}"))?
            .check()
            .map_err(|e| format!("X11 rejected pointer centering: {e}"))?;
        return Ok(());
    }
    let connection = Connection::connect_to_env()
        .map_err(|e| format!("Cannot connect to the Wayland desktop: {e}"))?;
    move_wayland(connection, point)
}

fn move_wayland(connection: Connection, point: Point) -> Result<(), String> {
    let mut queue = connection.new_event_queue();
    connection.display().get_registry(&queue.handle(), ());
    let mut state = State::default();
    let deadline = Instant::now() + Duration::from_secs(2);
    sync(&connection, &mut queue, &mut state, deadline)?;
    let input = state.input.as_ref().ok_or("KDE has not granted Window Warp pointer access. Install its Linux package with the supplied desktop entry, then restart Window Warp.")?;
    input.authenticate(
        "Window Warp".into(),
        "Center the pointer after a window shortcut".into(),
    );
    input.pointer_motion_absolute(f64::from(point.x), f64::from(point.y));
    sync(&connection, &mut queue, &mut state, deadline)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires an isolated Xvfb display and WARP_TEST_X11=1"]
    fn native_x11_pointer_round_trip() {
        use x11rb::{connection::Connection as _, protocol::xproto::ConnectionExt};
        assert_eq!(std::env::var("WARP_TEST_X11").as_deref(), Ok("1"));
        assert!(std::env::var_os("WAYLAND_DISPLAY").is_none());
        let (connection, screen) = x11rb::connect(None).unwrap();
        let root = connection.setup().roots[screen].root;
        for point in [Point { x: 37, y: 83 }, Point { x: 640, y: 360 }] {
            move_to(point).unwrap();
            let actual = connection.query_pointer(root).unwrap().reply().unwrap();
            assert_eq!(
                (i32::from(actual.root_x), i32::from(actual.root_y)),
                (point.x, point.y)
            );
        }
    }

    #[test]
    fn an_unresponsive_compositor_times_out_without_a_lingering_worker() {
        let (client, _server) = std::os::unix::net::UnixStream::pair().unwrap();
        let connection = Connection::from_socket(client).unwrap();
        let started = Instant::now();
        let error = move_wayland(connection, Point { x: 10, y: 20 }).unwrap_err();
        assert!(error.contains("within two seconds"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(4));
    }
}
