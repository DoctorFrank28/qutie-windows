"""Loads QUTIEUI.DLL like Unidrv does and calls its COM methods through the vtable."""

import ctypes
import sys
import uuid
from pathlib import Path

import pytest

DLL = Path(__file__).resolve().parents[1] / "driver" / "amd64" / "QUTIEUI.DLL"
pytestmark = pytest.mark.skipif(sys.platform != "win32" or not DLL.exists(), reason="needs the built plug-in")

CLSID_OEMUI = uuid.UUID("abce80d7-9f46-11d1-882a-00c04fb961ec")
IID_IClassFactory = uuid.UUID("00000001-0000-0000-c000-000000000046")
IID_IPrintOemUI2 = uuid.UUID("292515f9-b54b-489b-9275-bab56821395e")
IID_Bogus = uuid.UUID("11111111-2222-3333-4444-555555555555")
E_NOTIMPL = 0x80004001
CLASS_E_CLASSNOTAVAILABLE = 0x80040111

# IPrintOemUI2 vtable: IUnknown (0-2), GetInfo 3, DevMode 4, PublishDriverInterface 5,
# CommonUIProp 6, DocumentPropertySheets 7, DevicePropertySheets 8, ... HideStandardUI 18.


def guid(u: uuid.UUID):
    return ctypes.c_byte * 16, (ctypes.c_byte * 16).from_buffer_copy(u.bytes_le)


def method(obj: ctypes.c_void_p, index: int, *argtypes):
    vtable = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)))[0]
    proto = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, *argtypes)
    return lambda *args: proto(vtable[index])(obj, *args) & 0xFFFFFFFF


@pytest.fixture(scope="module")
def plugin():
    dll = ctypes.WinDLL(str(DLL))
    get = dll.DllGetClassObject
    get.restype = ctypes.c_long
    factory = ctypes.c_void_p()
    _, clsid = guid(CLSID_OEMUI)
    _, iid = guid(IID_IClassFactory)
    assert get(ctypes.byref(clsid), ctypes.byref(iid), ctypes.byref(factory)) == 0
    ui = ctypes.c_void_p()
    _, iid_ui = guid(IID_IPrintOemUI2)
    create = method(factory, 3, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p)
    assert create(None, ctypes.byref(iid_ui), ctypes.byref(ui)) == 0
    method(factory, 2)()  # Release
    yield dll, ui
    method(ui, 2)()


def test_wrong_class_is_refused():
    dll = ctypes.WinDLL(str(DLL))
    out = ctypes.c_void_p()
    _, clsid = guid(IID_Bogus)
    _, iid = guid(IID_IClassFactory)
    assert dll.DllGetClassObject(ctypes.byref(clsid), ctypes.byref(iid), ctypes.byref(out)) & 0xFFFFFFFF == CLASS_E_CLASSNOTAVAILABLE


def test_get_info(plugin):
    _, ui = plugin
    get_info = method(ui, 3, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p)
    value, needed = ctypes.c_ulong(), ctypes.c_ulong()
    assert get_info(1, ctypes.byref(value), 4, ctypes.byref(needed)) == 0  # OEMGI_GETSIGNATURE
    assert value.value == int.from_bytes(b"QTUI", "big") and needed.value == 4
    assert get_info(3, ctypes.byref(value), 4, ctypes.byref(needed)) == 0  # OEMGI_GETVERSION
    assert value.value == 0x00010000
    assert get_info(3, None, 0, ctypes.byref(needed)) != 0  # buffer too small


def test_no_private_devmode_and_standard_ui_kept_in_apps(plugin):
    _, ui = plugin
    assert method(ui, 4, ctypes.c_ulong, ctypes.c_void_p)(1, None) == E_NOTIMPL  # DevMode
    assert method(ui, 5, ctypes.c_void_p)(None) == 0  # PublishDriverInterface
    # python.exe is an app, not a Windows settings host: the standard tabs stay.
    assert method(ui, 18, ctypes.c_ulong)(1) == E_NOTIMPL  # HideStandardUI(OEMCUIP_DOCPROP)
    assert method(ui, 18, ctypes.c_ulong)(2) == E_NOTIMPL  # HideStandardUI(OEMCUIP_PRNPROP)
