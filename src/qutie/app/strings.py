"""The few strings shown by Python itself (tray menu, notifications), in the Windows UI language."""

from __future__ import annotations

import ctypes
import locale

_STRINGS = {
    "en": {"settings": "Settings", "preview": "Preview before printing", "setup": "Setup and uninstall",
           "quit": "Quit", "running": "Qutie is ready", "failed": "The label was not printed",
           "printed": "Label sent to the Qutie", "open_studio": "Open Qutie Studio", "quick": "Quick print…",
           "reprint_last": "Reprint the last one", "preview_windows": "Preview for prints from Windows",
           "printer_settings": "Printer settings", "from_windows": "print from Windows",
           "waiting": "A print from Windows is waiting in the preview"},
    "it": {"settings": "Impostazioni", "preview": "Anteprima prima di stampare", "setup": "Installazione e disinstallazione",
           "quit": "Esci", "running": "Qutie è pronta", "failed": "L'etichetta non è stata stampata",
           "printed": "Etichetta inviata alla Qutie", "open_studio": "Apri Qutie Studio", "quick": "Stampa al volo…",
           "reprint_last": "Ristampa l'ultima", "preview_windows": "Anteprima per le stampe da Windows",
           "printer_settings": "Impostazioni stampante", "from_windows": "stampa da Windows",
           "waiting": "Una stampa da Windows aspetta nell'anteprima"},
    "es": {"settings": "Ajustes", "preview": "Vista previa antes de imprimir", "setup": "Instalación y desinstalación",
           "quit": "Salir", "running": "Qutie está lista", "failed": "La etiqueta no se imprimió",
           "printed": "Etiqueta enviada a la Qutie", "open_studio": "Abrir Qutie Studio", "quick": "Impresión rápida…",
           "reprint_last": "Reimprimir la última", "preview_windows": "Vista previa de las impresiones de Windows",
           "printer_settings": "Ajustes de la impresora", "from_windows": "impresión desde Windows",
           "waiting": "Una impresión de Windows espera en la vista previa"},
    "fr": {"settings": "Réglages", "preview": "Aperçu avant impression", "setup": "Installation et désinstallation",
           "quit": "Quitter", "running": "La Qutie est prête", "failed": "L'étiquette n'a pas été imprimée",
           "printed": "Étiquette envoyée à la Qutie", "open_studio": "Ouvrir Qutie Studio", "quick": "Impression rapide…",
           "reprint_last": "Réimprimer la dernière", "preview_windows": "Aperçu des impressions depuis Windows",
           "printer_settings": "Réglages de l'imprimante", "from_windows": "impression depuis Windows",
           "waiting": "Une impression depuis Windows attend dans l'aperçu"},
    "de": {"settings": "Einstellungen", "preview": "Vorschau vor dem Drucken", "setup": "Einrichtung und Deinstallation",
           "quit": "Beenden", "running": "Qutie ist bereit", "failed": "Das Etikett wurde nicht gedruckt",
           "printed": "Etikett an den Qutie gesendet", "open_studio": "Qutie Studio öffnen", "quick": "Schnelldruck…",
           "reprint_last": "Letztes erneut drucken", "preview_windows": "Vorschau für Drucke aus Windows",
           "printer_settings": "Druckereinstellungen", "from_windows": "Druck aus Windows",
           "waiting": "Ein Druck aus Windows wartet in der Vorschau"},
    "pt": {"settings": "Definições", "preview": "Pré-visualizar antes de imprimir", "setup": "Instalação e desinstalação",
           "quit": "Sair", "running": "A Qutie está pronta", "failed": "A etiqueta não foi impressa",
           "printed": "Etiqueta enviada para a Qutie", "open_studio": "Abrir o Qutie Studio", "quick": "Impressão rápida…",
           "reprint_last": "Reimprimir a última", "preview_windows": "Pré-visualizar impressões do Windows",
           "printer_settings": "Definições da impressora", "from_windows": "impressão do Windows",
           "waiting": "Uma impressão do Windows aguarda na pré-visualização"},
    "ru": {"settings": "Настройки", "preview": "Предпросмотр перед печатью", "setup": "Установка и удаление",
           "quit": "Выход", "running": "Qutie готов", "failed": "Этикетка не напечатана",
           "printed": "Этикетка отправлена на Qutie", "open_studio": "Открыть Qutie Studio", "quick": "Быстрая печать…",
           "reprint_last": "Повторить последнюю", "preview_windows": "Предпросмотр печати из Windows",
           "printer_settings": "Настройки принтера", "from_windows": "печать из Windows",
           "waiting": "Печать из Windows ждёт в предпросмотре"},
    "zh": {"settings": "设置", "preview": "打印前预览", "setup": "安装和卸载",
           "quit": "退出", "running": "Qutie 已就绪", "failed": "标签未打印", "printed": "标签已发送到 Qutie",
           "open_studio": "打开 Qutie Studio", "quick": "快速打印…", "reprint_last": "重新打印上一个",
           "preview_windows": "预览来自 Windows 的打印", "printer_settings": "打印机设置",
           "from_windows": "来自 Windows 的打印", "waiting": "来自 Windows 的打印正在预览中等待"},
    "ja": {"settings": "設定", "preview": "印刷前にプレビュー", "setup": "セットアップとアンインストール",
           "quit": "終了", "running": "Qutie の準備ができました", "failed": "ラベルは印刷されませんでした",
           "printed": "ラベルを Qutie に送信しました", "open_studio": "Qutie Studio を開く", "quick": "クイック印刷…",
           "reprint_last": "前回分を再印刷", "preview_windows": "Windows からの印刷をプレビュー",
           "printer_settings": "プリンターの設定", "from_windows": "Windows からの印刷",
           "waiting": "Windows からの印刷がプレビューで待機中です"},
}


def _language() -> str:
    try:
        lcid = ctypes.windll.kernel32.GetUserDefaultUILanguage()
        tag = locale.windows_locale.get(lcid, "en")
    except (AttributeError, OSError):
        tag = (locale.getlocale()[0] or "en")
    return tag.split("_")[0].lower()


LANG = _language()
if LANG not in _STRINGS:
    LANG = "en"


def t(key: str) -> str:
    return _STRINGS[LANG].get(key) or _STRINGS["en"][key]
