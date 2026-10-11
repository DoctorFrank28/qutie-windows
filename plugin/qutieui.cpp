// QUTIEUI.DLL - Unidrv UI plug-in of the HPRT Qutie driver.
//
// It connects the Windows printing dialogs to the Qutie app:
// - "Printing preferences" and "Printing defaults" opened from Windows (Settings,
//   the printer's properties) open the Qutie panel and close the Windows dialog;
// - in an app's print dialog the standard tabs stay (they hold that document's
//   settings) and a "Qutie" tab offers a button to open the panel;
// - "Printer properties" get the same "Qutie" tab.
//
// The plug-in runs inside every process that prints, so it does as little as
// possible: no private DEVMODE, every other method returns E_NOTIMPL.

#include <windows.h>
#include <objbase.h>
#include <winspool.h>
#include <winddiui.h>
#include <compstui.h>
#include <prsht.h>
#include <shellapi.h>
#include <initguid.h>
#include <printoem.h>
#include <prcomoem.h>
#include <wchar.h>

#include <new>

#include "resource.h"

namespace {

HINSTANCE g_instance = nullptr;
LONG g_objects = 0;
LONG g_locks = 0;

constexpr DWORD kSignature = 'QTUI';
constexpr DWORD kVersion = 0x00010000;

// ----------------------------------------------------------------------------- texts
struct Texts {
    const wchar_t* lang;
    const wchar_t* title;
    const wchar_t* text;
    const wchar_t* button;
    const wchar_t* missing;
};

const Texts kTexts[] = {
    {L"en", L"Qutie settings",
     L"Label size, media, tape feed, density and the printer status are in the Qutie panel.",
     L"Open the Qutie panel", L"The Qutie app is not installed: run Qutie Setup."},
    {L"it", L"Impostazioni Qutie",
     L"Formato, tipo di carta, avanzamento nastro, densità e stato della stampante sono nel pannello Qutie.",
     L"Apri il pannello Qutie", L"L'app Qutie non è installata: esegui Qutie Setup."},
    {L"es", L"Ajustes de Qutie",
     L"Tamaño, tipo de papel, avance de cinta, densidad y estado de la impresora están en el panel de Qutie.",
     L"Abrir el panel de Qutie", L"La app Qutie no está instalada: ejecuta Qutie Setup."},
    {L"fr", L"Réglages Qutie",
     L"Format, support, avance du ruban, densité et état de l'imprimante se trouvent dans le panneau Qutie.",
     L"Ouvrir le panneau Qutie", L"L'application Qutie n'est pas installée : lancez Qutie Setup."},
    {L"de", L"Qutie-Einstellungen",
     L"Format, Medium, Bandvorschub, Dichte und Druckerstatus findest du im Qutie-Bereich.",
     L"Qutie-Bereich öffnen", L"Die Qutie-App ist nicht installiert: Starte Qutie Setup."},
    {L"pt", L"Definições da Qutie",
     L"Tamanho, tipo de papel, avanço da fita, densidade e estado da impressora estão no painel Qutie.",
     L"Abrir o painel Qutie", L"A app Qutie não está instalada: execute o Qutie Setup."},
    {L"ru", L"Настройки Qutie",
     L"Размер, носитель, подача ленты, "
     L"плотность и состояние принтера "
     L"— в панели Qutie.",
     L"Открыть панель Qutie",
     L"Приложение Qutie не установлено: "
     L"запустите Qutie Setup."},
    {L"zh", L"Qutie 设置",
     L"标签尺寸、介质、走纸、浓度和打印机状态都在 Qutie 面板中。",
     L"打开 Qutie 面板", L"未安装 Qutie 应用：请运行 Qutie Setup。"},
    {L"ja", L"Qutie の設定",
     L"ラベルサイズ、用紙、紙送り、濃度、プリンターの状態は Qutie パネルにあります。",
     L"Qutie パネルを開く",
     L"Qutie アプリがインストールされていません。Qutie Setup を実行してください。"},
};

const Texts& T() {
    wchar_t name[LOCALE_NAME_MAX_LENGTH] = {};
    if (LCIDToLocaleName(MAKELCID(GetUserDefaultUILanguage(), SORT_DEFAULT), name, LOCALE_NAME_MAX_LENGTH, 0) > 0) {
        for (const Texts& t : kTexts) {
            if (_wcsnicmp(name, t.lang, 2) == 0) return t;
        }
    }
    return kTexts[0];
}

// ----------------------------------------------------------------------------- helpers
// Processes that show the dialogs of Windows itself (not an app printing a document).
bool IsWindowsSettingsHost() {
    wchar_t path[MAX_PATH] = {};
    if (!GetModuleFileNameW(nullptr, path, MAX_PATH)) return false;
    const wchar_t* exe = wcsrchr(path, L'\\');
    exe = exe ? exe + 1 : path;
    static const wchar_t* const kHosts[] = {
        L"rundll32.exe", L"explorer.exe", L"systemsettings.exe", L"printui.exe",
        L"dllhost.exe", L"mmc.exe", L"printmanagement.exe",
    };
    for (const wchar_t* host : kHosts) {
        if (_wcsicmp(exe, host) == 0) return true;
    }
    return false;
}

bool FindApp(wchar_t (&exe)[MAX_PATH]) {
    static const wchar_t* const kCandidates[] = {
        L"%ProgramW6432%\\Qutie\\Qutie.exe",
        L"%ProgramFiles%\\Qutie\\Qutie.exe",
    };
    for (const wchar_t* candidate : kCandidates) {
        DWORD n = ExpandEnvironmentStringsW(candidate, exe, MAX_PATH);
        if (n > 0 && n <= MAX_PATH && GetFileAttributesW(exe) != INVALID_FILE_ATTRIBUTES) return true;
    }
    return false;
}

bool OpenPanel(const wchar_t* section) {
    wchar_t exe[MAX_PATH];
    if (!FindApp(exe)) return false;
    wchar_t args[64];
    swprintf_s(args, L"--app --section %s", section);
    return reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"open", exe, args, nullptr, SW_SHOWNORMAL)) > 32;
}

struct PageData {
    const wchar_t* section;
    bool openAndClose;  // open the panel and close the Windows dialog right away
};

PageData g_docPage = {L"paper", false};
PageData g_docPageAuto = {L"paper", true};
PageData g_devicePage = {L"device", false};

INT_PTR CALLBACK PageProc(HWND dialog, UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
    case WM_INITDIALOG: {
        auto* page = reinterpret_cast<PROPSHEETPAGEW*>(lParam);
        auto* data = reinterpret_cast<PageData*>(page->lParam);
        SetWindowLongPtrW(dialog, DWLP_USER, reinterpret_cast<LONG_PTR>(data));
        const Texts& t = T();
        SetDlgItemTextW(dialog, IDC_TITLE, t.title);
        SetDlgItemTextW(dialog, IDC_TEXT, t.text);
        SetDlgItemTextW(dialog, IDC_OPEN, t.button);
        if (data && data->openAndClose) {
            if (OpenPanel(data->section)) {
                PostMessageW(GetParent(dialog), PSM_PRESSBUTTON, PSBTN_CANCEL, 0);
            } else {
                SetDlgItemTextW(dialog, IDC_TEXT, t.missing);
            }
        }
        return TRUE;
    }
    case WM_COMMAND:
        if (LOWORD(wParam) == IDC_OPEN && HIWORD(wParam) == BN_CLICKED) {
            auto* data = reinterpret_cast<PageData*>(GetWindowLongPtrW(dialog, DWLP_USER));
            if (!OpenPanel(data ? data->section : L"status")) SetDlgItemTextW(dialog, IDC_TEXT, T().missing);
            return TRUE;
        }
        break;
    }
    return FALSE;
}

HRESULT AddPage(PPROPSHEETUI_INFO info, LPARAM param, PageData* data) {
    LONG_PTR result = 0;
    switch (info->Reason) {
    case PROPSHEETUI_REASON_INIT: {
        PROPSHEETPAGEW page = {};
        page.dwSize = sizeof(page);
        page.dwFlags = PSP_DEFAULT;
        page.hInstance = g_instance;
        page.pszTemplate = MAKEINTRESOURCEW(IDD_QUTIE);
        page.pfnDlgProc = PageProc;
        page.lParam = reinterpret_cast<LPARAM>(data);
        result = info->pfnComPropSheet(info->hComPropSheet, CPSFUNC_ADD_PROPSHEETPAGEW,
                                       reinterpret_cast<LPARAM>(&page), 0);
        info->Result = result;
        return result > 0 ? S_OK : E_FAIL;
    }
    case PROPSHEETUI_REASON_SET_RESULT: {
        auto* outcome = reinterpret_cast<PSETRESULT_INFO>(param);
        info->Result = outcome ? outcome->Result : CPSUI_OK;
        return S_OK;
    }
    default:
        info->Result = 0;
        return S_OK;
    }
}

// ----------------------------------------------------------------------------- plug-in
class QutieUI final : public IPrintOemUI2 {
public:
    QutieUI() { InterlockedIncrement(&g_objects); }
    ~QutieUI() { InterlockedDecrement(&g_objects); }

    // IUnknown
    STDMETHODIMP QueryInterface(REFIID riid, void** object) override {
        if (!object) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_IPrintOemUI || riid == IID_IPrintOemUI2) {
            *object = static_cast<IPrintOemUI2*>(this);
            AddRef();
            return S_OK;
        }
        *object = nullptr;
        return E_NOINTERFACE;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs_); }
    STDMETHODIMP_(ULONG) Release() override {
        LONG count = InterlockedDecrement(&refs_);
        if (count == 0) delete this;
        return count;
    }

    // IPrintOemCommon
    STDMETHODIMP GetInfo(DWORD mode, PVOID buffer, DWORD size, PDWORD needed) override {
        if (!needed || (mode != OEMGI_GETSIGNATURE && mode != OEMGI_GETVERSION)) {
            SetLastError(ERROR_INVALID_PARAMETER);
            return E_FAIL;
        }
        *needed = sizeof(DWORD);
        if (!buffer || size < sizeof(DWORD)) {
            SetLastError(ERROR_INSUFFICIENT_BUFFER);
            return E_FAIL;
        }
        *static_cast<PDWORD>(buffer) = mode == OEMGI_GETSIGNATURE ? kSignature : kVersion;
        return S_OK;
    }
    STDMETHODIMP DevMode(DWORD, POEMDMPARAM) override { return E_NOTIMPL; }

    // IPrintOemUI
    STDMETHODIMP PublishDriverInterface(IUnknown*) override { return S_OK; }
    STDMETHODIMP CommonUIProp(DWORD, POEMCUIPPARAM) override { return E_NOTIMPL; }
    STDMETHODIMP DocumentPropertySheets(PPROPSHEETUI_INFO info, LPARAM param) override {
        if (!info) return E_INVALIDARG;
        return AddPage(info, param, IsWindowsSettingsHost() ? &g_docPageAuto : &g_docPage);
    }
    STDMETHODIMP DevicePropertySheets(PPROPSHEETUI_INFO info, LPARAM param) override {
        if (!info) return E_INVALIDARG;
        return AddPage(info, param, &g_devicePage);
    }
    STDMETHODIMP DevQueryPrintEx(POEMUIOBJ, PDEVQUERYPRINT_INFO, PDEVMODE, PVOID) override { return E_NOTIMPL; }
    STDMETHODIMP DeviceCapabilities(POEMUIOBJ, HANDLE, PWSTR, WORD, PVOID, PDEVMODE, PVOID, DWORD, DWORD*) override {
        return E_NOTIMPL;
    }
    STDMETHODIMP UpgradePrinter(DWORD, PBYTE) override { return E_NOTIMPL; }
    STDMETHODIMP PrinterEvent(PWSTR, INT, DWORD, LPARAM) override { return E_NOTIMPL; }
    STDMETHODIMP DriverEvent(DWORD, DWORD, LPBYTE, LPARAM) override { return E_NOTIMPL; }
    STDMETHODIMP QueryColorProfile(HANDLE, POEMUIOBJ, PDEVMODE, PVOID, ULONG, VOID*, ULONG*, FLONG*) override {
        return E_NOTIMPL;
    }
    STDMETHODIMP FontInstallerDlgProc(HWND, UINT, WPARAM, LPARAM) override { return E_NOTIMPL; }
    STDMETHODIMP UpdateExternalFonts(HANDLE, HANDLE, PWSTR) override { return E_NOTIMPL; }

    // IPrintOemUI2
    STDMETHODIMP QueryJobAttributes(HANDLE, PDEVMODE, DWORD, LPBYTE) override { return E_NOTIMPL; }
    STDMETHODIMP HideStandardUI(DWORD mode) override {
        // Only the dialogs of Windows itself become "just the Qutie panel".
        return (mode == OEMCUIP_DOCPROP && IsWindowsSettingsHost()) ? S_OK : E_NOTIMPL;
    }
    STDMETHODIMP DocumentEvent(HANDLE, HDC, INT, ULONG, PVOID, ULONG, PVOID, PINT) override { return E_NOTIMPL; }

private:
    LONG refs_ = 1;
};

class ClassFactory final : public IClassFactory {
public:
    STDMETHODIMP QueryInterface(REFIID riid, void** object) override {
        if (!object) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_IClassFactory) {
            *object = static_cast<IClassFactory*>(this);
            AddRef();
            return S_OK;
        }
        *object = nullptr;
        return E_NOINTERFACE;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs_); }
    STDMETHODIMP_(ULONG) Release() override {
        LONG count = InterlockedDecrement(&refs_);
        if (count == 0) delete this;
        return count;
    }
    STDMETHODIMP CreateInstance(IUnknown* outer, REFIID riid, void** object) override {
        if (!object) return E_POINTER;
        *object = nullptr;
        if (outer) return CLASS_E_NOAGGREGATION;
        auto* ui = new (std::nothrow) QutieUI();
        if (!ui) return E_OUTOFMEMORY;
        HRESULT hr = ui->QueryInterface(riid, object);
        ui->Release();
        return hr;
    }
    STDMETHODIMP LockServer(BOOL lock) override {
        lock ? InterlockedIncrement(&g_locks) : InterlockedDecrement(&g_locks);
        return S_OK;
    }

private:
    LONG refs_ = 1;
};

}  // namespace

// ----------------------------------------------------------------------------- exports
BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        g_instance = instance;
        DisableThreadLibraryCalls(instance);
    }
    return TRUE;
}

STDAPI DllGetClassObject(REFCLSID clsid, REFIID riid, LPVOID* object) {
    if (!object) return E_POINTER;
    *object = nullptr;
    if (clsid != CLSID_OEMUI) return CLASS_E_CLASSNOTAVAILABLE;
    auto* factory = new (std::nothrow) ClassFactory();
    if (!factory) return E_OUTOFMEMORY;
    HRESULT hr = factory->QueryInterface(riid, object);
    factory->Release();
    return hr;
}

STDAPI DllCanUnloadNow() {
    return (g_objects == 0 && g_locks == 0) ? S_OK : S_FALSE;
}
