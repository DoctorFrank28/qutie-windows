"""Bluetooth discovery and pairing through WinRT, without going through Windows Settings."""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass

from winrt.windows.devices.bluetooth import BluetoothDevice
from winrt.windows.devices.enumeration import (
    DeviceInformation,
    DevicePairingKinds,
    DevicePairingResultStatus,
)

DEFAULT_PINS = ("0000", "1234")


@dataclass
class Found:
    name: str
    mac: str
    paired: bool
    info: DeviceInformation


def _mac_from_id(device_id: str) -> str:
    # Ids look like "Bluetooth#Bluetooth11:22:33:44:55:66-aa:bb:cc:dd:ee:ff"
    found = re.findall(r"([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})", device_id)
    return found[-1].upper() if found else ""


async def _scan(paired: bool) -> list[Found]:
    selector = BluetoothDevice.get_device_selector_from_pairing_state(paired)
    devices = await DeviceInformation.find_all_async_aqs_filter(selector)
    return [Found(d.name, _mac_from_id(d.id), paired, d) for d in devices]


def scan() -> list[Found]:
    """Classic Bluetooth devices: paired ones first, then those visible nearby."""

    async def everything():
        return await _scan(True) + await _scan(False)

    return asyncio.run(everything())


async def _pair(info: DeviceInformation, pin: str | None) -> str:
    custom = info.pairing.custom

    def requested(_sender, args):
        if args.pairing_kind == DevicePairingKinds.PROVIDE_PIN:
            args.accept_with_pin(pin or DEFAULT_PINS[0])
        else:
            args.accept()

    token = custom.add_pairing_requested(requested)
    try:
        kinds = (
            DevicePairingKinds.CONFIRM_ONLY
            | DevicePairingKinds.DISPLAY_PIN
            | DevicePairingKinds.PROVIDE_PIN
            | DevicePairingKinds.CONFIRM_PIN_MATCH
        )
        result = await custom.pair_async(kinds)
    finally:
        custom.remove_pairing_requested(token)
    if result.status in (DevicePairingResultStatus.PAIRED, DevicePairingResultStatus.ALREADY_PAIRED):
        return "paired"
    return DevicePairingResultStatus(result.status).name.lower()


def pair(info: DeviceInformation, pin: str | None = None) -> str:
    """Pair the device; returns "paired" or the WinRT failure status in lower case."""
    return asyncio.run(_pair(info, pin))


def unpair(name_pattern: str = r"qutie|hprt|\bq2\b") -> list[str]:
    """Remove the pairing of every device whose name matches; returns the names removed."""

    async def _unpair():
        removed = []
        for found in await _scan(True):
            if re.search(name_pattern, found.name, re.IGNORECASE):
                result = await found.info.pairing.unpair_async()
                if result.status in (0, 1):  # Unpaired / AlreadyUnpaired
                    removed.append(found.name)
        return removed

    return asyncio.run(_unpair())
