# Qutie driver for Windows

[![Tests](https://github.com/DoctorFrank28/qutie-windows/actions/workflows/tests.yml/badge.svg)](https://github.com/DoctorFrank28/qutie-windows/actions/workflows/tests.yml)
[![Latest release](https://img.shields.io/github/v/release/DoctorFrank28/qutie-windows)](https://github.com/DoctorFrank28/qutie-windows/releases/latest)

Print on the **HPRT Qutie** Bluetooth label maker from any Windows app (Excel, browsers, Word, …) without the phone app. The **HPRT Q2** speaks the same protocol.

- **Qutie Studio.** A label editor made for 12 mm tape: text, shapes, images, barcodes and QR codes, with a view of the exact dots the print head makes and per-object dithering. Labels can be linked to Excel, CSV or JSON data (one label per row, formula fields, conditional visibility). It also has templates, print history, quick print from the tray and a dark theme.
- **Native Windows printer.** An Unidrv minidriver (a GPD file) plus a small UI plug-in. In Windows, *Printing preferences* opens the Qutie panel.
- **Print preview.** Every job opens a preview of the labels exactly as they will print: copies, single-strip view, same height across labels. Print or cancel from there.
- **Fit to tape.** With the default paper size, *Fit to tape (A5)*, apps keep their usual margins. The Qutie app crops the content and scales it to the 12 mm tape, and the label is as long as it needs to be.
- **Settings panel.** Battery, firmware, print density, auto power off, paper size, media type, tape feed and the margin on continuous tape.
- **Setup wizard.** `Qutie-Setup.exe` finds the printer over Bluetooth, pairs it and installs the driver, optionally with Qutie Studio. You can add or remove the Studio later. Uninstalling works from *Installed apps*.
- **Languages.** English, Italian, Spanish, French, German, Portuguese, Russian, Chinese and Japanese, following the Windows language.

![Qutie Studio: a freezer label in the dots view](.github/images/editor.png)

| Templates | Printing a series from data | Setup |
| --- | --- | --- |
| ![Built-in templates](.github/images/templates.png) | ![Print preview of one label per row](.github/images/print.png) | ![Choosing the driver and Qutie Studio](.github/images/setup.png) |

## Install

You need Windows 10 or 11 (x64) with Bluetooth, and a Qutie (or Q2).


1. Turn the Qutie on and close the HerePrint / Sorticker app on your phone, because the printer accepts one connection at a time.
2. Download `Qutie-Setup.exe` from the [latest release](https://github.com/DoctorFrank28/qutie-windows/releases/latest) and run it. The file is not code-signed, so Windows SmartScreen may warn you: choose *More info › Run anyway*.
3. Choose **Driver and Qutie Studio** or **Driver only**, then follow the steps. Windows asks for administrator permission once, to install the driver.

Then print from any app on the **Qutie** printer, or open **Qutie Studio** from the Start menu or the tray icon. Uninstall from *Settings › Apps › Installed apps › Qutie Studio and printer* (or *Qutie printer* with the driver only).

To update, run the new `Qutie-Setup.exe`: labels, templates and settings stay. *Help › Check for updates* in the Studio (or *About* in the printer settings) tells you when there is one. Found a bug? *Help › Report a problem* opens a [GitHub issue](https://github.com/DoctorFrank28/qutie-windows/issues) with the versions filled in.

### About the driver signature

Windows only installs signed drivers. The setup does not ship a certificate. Instead it:

1. creates a self-signed certificate on your PC;
2. signs the driver catalog with it;
3. trusts the certificate;
4. **deletes its private key**.

From then on the certificate cannot sign anything else. Uninstalling removes it.

## How it works

```mermaid
flowchart LR
    A[Any app] --> B[Windows spooler]
    B --> C[Unidrv + QUTIE.GPD]
    C -->|raster file| D[Qutie app]
    D -->|preview, fit to tape| E[Bluetooth RFCOMM]
    E --> F[Qutie]
    G[Printing preferences] --> H[QUTIEUI.DLL] --> D
```

- **Driver** (`driver/`). `QUTIE.GPD` turns each page into the printer's raster blocks. The printer port is a file, `C:\ProgramData\Qutie\spool\job.prn`.
- **App** (`src/qutie/app/`). Built with pywebview and a tray icon. It picks each job up, decodes it (`spool.py`), shows the preview and sends the bytes over a Bluetooth socket. It waits for the printer to confirm (`dithering_finish`) before closing the link.
  - The Bluetooth COM port Windows creates is not used. Windows opens that link lazily, and short writes can be lost.
- **UI plug-in** (`plugin/`). `QUTIEUI.DLL` is an `IPrintOemUI2` plug-in that opens the Qutie panel from the Windows printing dialogs.

### Qutie Studio

The Studio is a pywebview window of the same app (`src/qutie/app/web/designer.html`, `designer/*.js`, API in `src/qutie/app/designer.py`).

- **Engine.** The page draws every object at 203 dpi, dithers it and stacks the 1-bit layers. What the *Dots* view shows is what prints.
  - `model.js` defines the `.qutie` document.
  - `data.js` handles fields, formulas, filters, copies and the print plan.
  - `render.js` turns a document into dots.
- **Python.** It provides what a page cannot do by itself:
  - system fonts;
  - barcodes and QR codes (`codes.py`: python-barcode, segno, read-back check with zxing-cpp);
  - data files (`datasource.py`: openpyxl, CSV, JSON);
  - the label library and print history (`library.py`);
  - the printer. Studio prints go straight over Bluetooth, one label at a time, so a print can stop and resume.
- **Files.** Labels are `.qutie` files (JSON) in *Documents\Qutie*. Templates and the history are in `%APPDATA%\Qutie`.
- **Formulas.** They use spreadsheet function names in English or Italian, for example `IF(ISBLANK([Expires]); ADDDAYS([Date]; 90); [Expires])`.
- **Languages.** The Studio is in the same nine languages as the rest of the app.

### Protocol

Worked out, for interoperability, by studying how the official app talks to the printer. Details are in [`src/qutie/protocol.py`](src/qutie/protocol.py).

| What | Bytes |
| --- | --- |
| Link | Bluetooth classic SPP (RFCOMM channel 1), or Bluetooth LE: service `FF00`, write to `FF02`, replies on `FF01`, flow control on `FF03` |
| Optional handshake | `1B 1C "set mm" k1 k2`. An `OK` reply means later writes are XORed with `k1+k2`. Plain data works too. |
| Raster block | `1D 76 30 30` · width in bytes (2) · rows (2) · LZO length (4) · LZO1X data |
| End of a gap label | `1D 66 nL nH` (length in dots, 203 dpi) |
| Feed | `1B 1B 01 nL nH` |
| Density / auto power off | `1D "setc" n` / `1D "sett" nL nH` (seconds) |
| Status / info | `1B 12 73` (17 bytes) / `1B 12 64` (143 bytes) |

The print head is 96 dots wide (12 mm at 203 dpi). In the status reply, paper type 0 is the continuous roll. The printer prints each raster block as soon as it gets it and sends `dithering_finish` when it has printed all it received; over Bluetooth LE send 180-byte packets without waiting, or it stops between blocks and leaves gaps.

## JavaScript library

[`qutie.js`](web/qutie.js) prints on the Qutie straight from a web page, with no app and no server: over **Bluetooth LE** (Web Bluetooth: Chrome and Edge on Android, Windows, macOS, Linux and ChromeOS) or the **Bluetooth serial port** (Web Serial: Chrome and Edge on desktop). It needs HTTPS. Safari, Firefox and iPhone have neither API.

Try it on the [demo page](https://doctorfrank28.github.io/qutie-windows/), or use it:

```js
import Qutie from "https://doctorfrank28.github.io/qutie-windows/qutie.js";

button.onclick = async () => {
  const printer = await Qutie.connect();          // Chrome shows the nearby Qutie
  console.log(await printer.status());            // { battery: 82, paper: "continuous", density: 95, … }
  await printer.printText("Spices", { length: 30 });
  await printer.print("labels/jar.qutie", { fields: { Name: "Oregano" } });          // a Qutie Studio label
  await printer.print(doc, { rows: [{ Box: "1", Contents: "cables" }, { Box: "2", Contents: "books" }] });
};
```

- **Labels from Qutie Studio** print as in the Studio: the library draws them with the Studio's own engine (fields and formulas, `{date}` and the other variables, the counter, conditional visibility, copies, every fill and dithering). `fields` fills in one label, `rows` makes one label per row; without either the rows saved in the file print. Other options: `copies`, `start` and `count` for the counter, `now` for the date, `onProgress`.
- `printer.printImage(file, { length: "auto" })` prints a picture; `printer.feed()`, `setDensity()`, `setAutoOff()`, `info()` and `disconnect()` do what they say; a `disconnect` event tells when the printer goes away.
- `Qutie.preview(label, options)` returns canvases with the printed dots, `Qutie.fields(label)` the fields a label can be given, and `Qutie.setLanguage("it")` the language of dates and numbers.
- Barcodes are the Studio's (Code 128, EAN-13/8, UPC-A, ITF-14, Code 39, Codabar); QR codes follow the reference encoder. Micro QR is not available in the browser.
- Fonts are the device's: a label made with Segoe UI uses the system sans-serif on Android.

`web/qutie.js` is built from [`js/`](js) and the Studio's engine by `tools/build_js.py`; [`web/serial-test.html`](web/serial-test.html) is a lower-level connection test that logs every byte.

## Command line

```bash
uv sync
uv run qutie pair
uv run qutie status
uv run qutie text "Spices\nKitchen" --length 30
uv run qutie image logo.png --dither
uv run qutie text "Test" --preview test.png
```

## Development

```bash
uv sync
uv run pytest
uv run python -m qutie.app.designer
uv run python tools/build_js.py
uv run qutie-app --setup
plugin\build.cmd
uv run python packaging/make_icon.py
uv run pyinstaller packaging/qutie.spec --noconfirm
```

- **`--setup`** opens the setup wizard; **`--studio [file]`** opens Qutie Studio; **`--quick`** opens quick print.
- **`uv run python -m qutie.app.designer`** serves the Studio at http://127.0.0.1:4180/designer.html, to work on it in a browser.
- **`plugin\build.cmd`** builds `driver/amd64/QUTIEUI.DLL`. It needs Visual Studio 2022 with the C++ tools.
- **`pyinstaller`** builds `dist/Qutie.exe` and `dist/Qutie-Setup.exe`.

The driver can also be installed without the app: run `driver/Install.cmd` once the printer is paired. It then prints straight to the Bluetooth COM port, with no preview.

### Releasing

1. Set the new version in `pyproject.toml`, `src/qutie/__init__.py`, `driver/install.ps1` (`DisplayVersion`) and `driver/qutie.inf` (`DriverVer`), then run `uv lock`. `tests/test_release.py` checks that they match.
2. Commit, then tag and push: `git tag v1.2.0` and `git push origin v1.2.0`.
3. The [Release workflow](.github/workflows/release.yml) runs the tests, builds `Qutie-Setup.exe` and attaches it to the GitHub release of that tag.

## License

[MIT](LICENSE). HPRT, Qutie, HerePrint and Sorticker are trademarks of their owners. This project is not affiliated with HPRT.
