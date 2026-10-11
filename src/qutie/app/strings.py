"""The few strings shown by Python itself (tray menu, notifications), in the Windows UI language."""

from __future__ import annotations

import ctypes
import locale

_STRINGS = {
    "en": {"settings": "Settings", "preview": "Preview before printing", "setup": "Setup and uninstall",
           "quit": "Quit", "running": "Qutie is ready", "failed": "The label was not printed",
           "printed": "Label sent to the Qutie"},
    "it": {"settings": "Impostazioni", "preview": "Anteprima prima di stampare", "setup": "Installazione e disinstallazione",
           "quit": "Esci", "running": "Qutie è pronta", "failed": "L'etichetta non è stata stampata",
           "printed": "Etichetta inviata alla Qutie"},
    "es": {"settings": "Ajustes", "preview": "Vista previa antes de imprimir", "setup": "Instalación y desinstalación",
           "quit": "Salir", "running": "Qutie está lista", "failed": "La etiqueta no se imprimió",
           "printed": "Etiqueta enviada a la Qutie"},
    "fr": {"settings": "Réglages", "preview": "Aperçu avant impression", "setup": "Installation et désinstallation",
           "quit": "Quitter", "running": "La Qutie est prête", "failed": "L'étiquette n'a pas été imprimée",
           "printed": "Étiquette envoyée à la Qutie"},
    "de": {"settings": "Einstellungen", "preview": "Vorschau vor dem Drucken", "setup": "Einrichtung und Deinstallation",
           "quit": "Beenden", "running": "Qutie ist bereit", "failed": "Das Etikett wurde nicht gedruckt",
           "printed": "Etikett an den Qutie gesendet"},
    "pt": {"settings": "Definições", "preview": "Pré-visualizar antes de imprimir", "setup": "Instalação e desinstalação",
           "quit": "Sair", "running": "A Qutie está pronta", "failed": "A etiqueta não foi impressa",
           "printed": "Etiqueta enviada para a Qutie"},
    "ru": {"settings": "Настройки", "preview": "Предпросмотр перед печатью", "setup": "Установка и удаление",
           "quit": "Выход", "running": "Qutie готов", "failed": "Этикетка не напечатана",
           "printed": "Этикетка отправлена на Qutie"},
    "zh": {"settings": "设置", "preview": "打印前预览", "setup": "安装和卸载",
           "quit": "退出", "running": "Qutie 已就绪", "failed": "标签未打印", "printed": "标签已发送到 Qutie"},
    "ja": {"settings": "設定", "preview": "印刷前にプレビュー", "setup": "セットアップとアンインストール",
           "quit": "終了", "running": "Qutie の準備ができました", "failed": "ラベルは印刷されませんでした",
           "printed": "ラベルを Qutie に送信しました"},
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
