#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Native companion acceptance; run only inside tests/kde/nested.sh isolation."""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tests' / 'kde'))
from wayland_input import Input
from gi.repository import Gio, GLib
from PyQt5.QtWidgets import QApplication, QWidget

assert os.environ.get('WAYLAND_DISPLAY') == 'warp-test'
assert os.environ.get('WARP_PRIVATE_DBUS_DATA_HOME') == os.environ.get('XDG_DATA_HOME')
assert str(Path(os.environ['XDG_RUNTIME_DIR'])).startswith('/tmp/window-warp-')
app = QApplication([])
window = QWidget()
window.setWindowTitle('WARP-COMPANION-NATIVE-OWNED')
window.resize(400, 300)
window.show()
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
context = GLib.MainContext.default()
events, snapshots, checks = [], [], []
token = str(uuid.uuid4())
generation = 'native-1'
iface = 'com.windowwarp.Companion'
plugin = 'windowwarp_companion'
support = 'windowwarp_companion_test'
path = '/WindowWarpCompanion'
bindings = [{'id':'warp-companion-K','shortcut':'Ctrl+Alt+Shift+K'},
            {'id':'warp-companion-L','shortcut':'Ctrl+Alt+Shift+L'}]
failure_mode = False
delayed = []


def call(service, path, interface, method, signature='()', args=(), connection=bus):
    return connection.call_sync(service,path,interface,method,GLib.Variant(signature,args),None,
                                Gio.DBusCallFlags.NONE,3000,None).unpack()


def pump(duration=0.08):
    deadline = time.monotonic()+duration
    while time.monotonic() < deadline:
        app.processEvents()
        while context.pending(): context.iteration(False)
        time.sleep(0.002)


def wait(predicate, message, timeout=3):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        pump(0.01)
        if predicate(): return
    raise AssertionError(message)


def check(condition, name):
    assert condition, name
    checks.append(name)


def owner(name):
    return call('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','NameHasOwner','(s)',(name,))[0]


def load(name):
    assert call('org.kde.KWin','/Plugins','org.kde.KWin.Plugins','LoadPlugin','(s)',(name,))[0]


def unload(name):
    call('org.kde.KWin','/Plugins','org.kde.KWin.Plugins','UnloadPlugin','(s)',(name,))


def forget_shortcuts(identifiers):
    names=call('org.kde.kglobalaccel','/component/kwin','org.kde.kglobalaccel.Component','shortcutNames')[0]
    for identifier in identifiers:
        if identifier in names:
            assert call('org.kde.kglobalaccel','/kglobalaccel','org.kde.KGlobalAccel','unregister','(ss)',('kwin',identifier))[0]


def configure(items=bindings, gen=None, connection=bus):
    call(iface,path,iface,'Configure','(sss)',(token,generation if gen is None else gen,json.dumps(items)),connection)
    pump()


def received(connection,sender,object_path,interface,method,parameters,invocation):
    values=parameters.unpack()
    if method=='ScriptSnapshot':
        snapshots.append(json.loads(values[0]))
    else:
        secret,gen,identifier,phase,cycle,capture=values
        assert secret == token
        events.append({'generation':gen,'id':identifier,'phase':phase,'cycle':cycle,'capture':json.loads(capture)})
        if failure_mode=='delay':
            delayed.append(invocation)
            return
        if failure_mode:
            invocation.return_dbus_error('com.windowwarp.Test.Rejected','Owned fixture failure')
            return
    invocation.return_value(GLib.Variant('()',()))


xml='''<node><interface name="com.windowwarp.Control">
<method name="PhysicalKey"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="t" direction="in"/><arg type="s" direction="in"/></method>
<method name="ScriptSnapshot"><arg type="s" direction="in"/></method></interface></node>'''
registration=bus.register_object('/Control',Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0],received,None,None)
assert call('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','RequestName','(su)',('com.windowwarp.Control',4))[0]==1
receipt={'passed':False,'checks':checks,'events':events}
loaded=[]
script='window-warp-companion-native-fixture'
try:
    with tempfile.TemporaryDirectory(prefix='warp-companion-native-') as temporary, Input() as keys:
        source=Path(temporary)/'shortcuts.js'
        source.write_text('''["K","L"].forEach(function(key){registerShortcut("warp-companion-"+key,"Owned "+key,"Ctrl+Alt+Shift+"+key,function(){
var w=("activeWindow" in workspace)?workspace.activeWindow:workspace.activeClient;var p=workspace.cursorPos;callDBus("com.windowwarp.Control","/Control","com.windowwarp.Control","ScriptSnapshot",JSON.stringify({x:Math.round(p.x),y:Math.round(p.y),previous:w?{id:String(w.internalId),pid:Number(w.pid)}:null}));});});''')
        identifier=call('org.kde.KWin','/Scripting','org.kde.kwin.Scripting','loadScript','(ss)',(str(source),script))[0]
        try:
            call('org.kde.KWin','/Scripting/Script'+str(identifier),'org.kde.kwin.Script','run')
        except GLib.Error as error:
            if 'UnknownObject' not in str(error): raise
            call('org.kde.KWin','/'+str(identifier),'org.kde.kwin.Script','run')
        load(plugin);loaded.append(plugin)
        load(support);loaded.append(support)
        info=json.loads(call(iface,path,iface,'Info')[0]);receipt['info']=info
        check(info['protocol']==1,'protocol version')
        configure()
        wait(lambda: window.isActiveWindow(),'owned window active')
        outsider=Gio.DBusConnection.new_for_address_sync(os.environ['DBUS_SESSION_BUS_ADDRESS'],Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT|Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,None,None)
        try:
            configure(connection=outsider)
            raise AssertionError('Unauthorized configure was accepted')
        except GLib.Error as error:
            check('Unauthorized' in str(error),'only control owner may configure')
        finally: outsider.close_sync(None)
        try:
            configure([bindings[0],bindings[0]])
            raise AssertionError('Duplicate configure was accepted')
        except GLib.Error as error:
            check('InvalidBindings' in str(error),'invalid configuration leaves session intact')

        def modifiers():
            for code in [29,56,42]: keys.key(code,True)
        def phase_list(start): return [(e['id'][-1],e['phase']) for e in events[start:]]

        keys.pointer(330,220);pump()
        for first,second in [(37,38),(38,37)]:
            start=len(events);snap_start=len(snapshots)
            modifiers();keys.key(first,True);pump();keys.key(second,True);pump()
            keys.key(second,False);pump();keys.key(first,False);keys.release();pump()
            a,b=('K','L') if first==37 else ('L','K')
            check(phase_list(start)==[(a,'down'),(b,'down'),(b,'up'),(a,'up')],a+' then '+b+' independent lifetime')
            downs=[e for e in events[start:] if e['phase']=='down']
            wait(lambda:len(snapshots)>=snap_start+2,'script captures delivered')
            for event,snapshot in zip(downs,snapshots[snap_start:snap_start+2]):
                capture=event['capture']
                check(capture['previous']==snapshot['previous'] and capture['previous']['pid']==os.getpid()
                    and (capture['x'],capture['y'])==(330,220)==(snapshot['x'],snapshot['y']),
                    'native capture matches actual script identity/pointer '+str(event['cycle']))
        start=len(events);modifiers();keys.key(37,True);pump(0.9)
        check(phase_list(start)==[('K','down')],'repeat never creates new cycle')
        keys.key(42,False);pump();keys.key(42,True);pump(0.7)
        check(phase_list(start)==[('K','down'),('K','up')],'modifier-first release guards held base')
        keys.key(37,False);keys.release();pump()
        check(len(events)==start+2,'base release does not duplicate modifier release')

        # libinput merges same-code keys across devices: first press may be A,
        # final release B. Inject that exact stream, not two independent downs.
        start=len(events);modifiers();keys.key(37,True);pump()
        with Input() as second_keyboard:
            second_keyboard.key(36,True);second_keyboard.key(36,False);pump()
            assert call('org.kde.KWin','/WindowWarpCompanionTest','com.windowwarp.CompanionTest','SeatRelease','(u)',(37,))[0]
            pump()
        check(phase_list(start)==[('K','down'),('K','up')],'seat release from another keyboard closes cycle')
        keys.key(37,False);keys.key(37,True);pump();keys.key(37,False);keys.release();pump()
        check(phase_list(start)==[('K','down'),('K','up'),('K','down'),('K','up')],'cross-device release clears original keyboard guard')

        start=len(events);modifiers();keys.key(37,True);pump();configure([],gen='')
        generation='native-2';configure();keys.key(42,False);keys.key(42,True);pump(0.7)
        check(phase_list(start)==[('K','down'),('K','cancel')],'pause resume cancels and guards held base')
        keys.key(37,False);keys.key(37,True);pump();keys.key(37,False);keys.release();pump()
        check(phase_list(start)==[('K','down'),('K','cancel'),('K','down'),('K','up')],'fresh base works after pause guard release')
        configure([]);start=len(events);modifiers();keys.key(37,True);pump()
        generation='native-3';configure();keys.key(42,False);keys.key(42,True);pump(0.8)
        check(len(events)==start,'already-held base before Configure cannot activate')
        keys.release();pump()

        # Replace the reservation while its admitted base remains physically held.
        start=len(events);modifiers();keys.key(37,True);pump();configure([])
        call('org.kde.KWin','/Scripting','org.kde.kwin.Scripting','unloadScript','(s)',(script,))
        forget_shortcuts(['warp-companion-K','warp-companion-L'])
        direct=Path(temporary)/'direct.js'
        direct.write_text('registerShortcut("warp-companion-direct-K","Owned direct","Ctrl+Alt+Shift+K",function(){callDBus("com.windowwarp.Control","/Control","com.windowwarp.Control","ScriptSnapshot",JSON.stringify({direct:true}));});\nregisterShortcut("warp-companion-unguarded-L","Owned repeat","Ctrl+Alt+Shift+L",function(){callDBus("com.windowwarp.Control","/Control","com.windowwarp.Control","ScriptSnapshot",JSON.stringify({unguarded:true}));});')
        direct_name=script+'-direct'
        def run_script(file,name):
            script_id=call('org.kde.KWin','/Scripting','org.kde.kwin.Scripting','loadScript','(ss)',(str(file),name))[0]
            try: call('org.kde.KWin','/Scripting/Script'+str(script_id),'org.kde.kwin.Script','run')
            except GLib.Error as error:
                if 'UnknownObject' not in str(error): raise
                call('org.kde.KWin','/'+str(script_id),'org.kde.kwin.Script','run')
        run_script(direct,direct_name);pump(0.9)
        check(not any(s.get('direct') for s in snapshots),'held reassigned chord cannot repeat into direct action')
        keys.key(38,True);pump(0.9);keys.key(38,False);pump()
        check(sum(bool(s.get('unguarded')) for s in snapshots)>1,'unguarded direct shortcut repeats pass unchanged')
        keys.release();pump();modifiers();keys.key(37,True);pump();keys.release();pump()
        check(sum(bool(s.get('direct')) for s in snapshots)==1,'direct reassignment accepts a fresh press after base release')
        call('org.kde.KWin','/Scripting','org.kde.kwin.Scripting','unloadScript','(s)',(direct_name,))
        forget_shortcuts(['warp-companion-direct-K','warp-companion-unguarded-L'])
        run_script(source,script);configure()

        start=len(events);keys.key(37,True);keys.key(37,False);keys.key(36,True);keys.key(36,False);pump()
        check(len(events)==start,'plain configured letters and unrelated text do not export')
        call('org.kde.KWin','/component/kwin','org.kde.kglobalaccel.Component','invokeShortcut','(s)',('warp-companion-K',));pump()
        check(len(events)==start,'programmatic activation without physical dispatch ignored')
        call('org.kde.KWin','/WindowWarpCompanionTest','com.windowwarp.CompanionTest','ModalThenInvoke','(su)',('warp-companion-K',37))
        modifiers();keys.key(37,True);pump();keys.release();keys.key(1,True);keys.key(1,False);pump()
        check(len(events)==start,'modal-filtered key and same-turn programmatic tail cannot activate')

        start=len(events);modifiers()
        with Input() as removed:
            removed.key(37,True);pump()
            assert call('org.kde.KWin','/WindowWarpCompanionTest','com.windowwarp.CompanionTest','RemoveLastDevice')[0]
            pump()
        keys.key(37,False);keys.release();pump()
        check(phase_list(start)==[('K','down'),('K','cancel')],'device removal cancels its cycle without tap')

        # Old-generation callback failures cannot tear down a newly configured session.
        failure_mode='delay';modifiers();keys.key(37,True);pump();keys.key(37,False);keys.release();pump()
        check(len(delayed)==2,'fixture retains exactly old down/up replies')
        failure_mode=False;generation='native-4';configure()
        for invocation in delayed: invocation.return_dbus_error('com.windowwarp.Test.Old','Old fixture reply')
        delayed.clear();pump()
        check(owner(iface),'old generation reply failure preserves current provider')
        start=len(events);failure_mode=True;modifiers();keys.key(37,True)
        wait(lambda:not owner(iface),'current callback failure releases provider')
        keys.release();pump();check(len(events)==start+1,'callback failure detaches before further release')
        failure_mode=False;unload(plugin);loaded.remove(plugin);load(plugin);loaded.append(plugin);configure()
        check(owner(iface),'explicit unload/load recovers failed provider')

        start=len(events);modifiers();keys.key(37,True);pump()
        call('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','ReleaseName','(s)',('com.windowwarp.Control',));pump()
        keys.release();pump()
        check(phase_list(start)==[('K','down')],'control name loss detaches observer')
        assert call('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','RequestName','(su)',('com.windowwarp.Control',4))[0]==1
        configure()

        start=len(events);modifiers();keys.key(37,True);pump()
        unload(plugin);loaded.remove(plugin);pump();keys.release();pump()
        check(not owner(iface) and phase_list(start)==[('K','down'),('K','cancel')],'unload cancels once and removes service')
        check(window.isActiveWindow(),'production companion preserves owned focus')
        receipt['passed']=True
finally:
    for name in reversed(loaded): unload(name)
    call('org.kde.KWin','/Scripting','org.kde.kwin.Scripting','unloadScript','(s)',(script,))
    if 'direct_name' in globals():
        call('org.kde.KWin','/Scripting','org.kde.kwin.Scripting','unloadScript','(s)',(direct_name,))
    bus.unregister_object(registration)
    receipt['providerAbsent']=not owner(iface)
    Path(os.environ['WARP_COMPANION_OUTPUT']).write_text(json.dumps(receipt,indent=2))
    print(json.dumps(receipt,indent=2),flush=True)
