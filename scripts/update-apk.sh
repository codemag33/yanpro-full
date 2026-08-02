#!/bin/bash
# Обновляет APK водителя из GitHub Release latest-apk (публичный репозиторий).
# Запуск: раз в 10-15 минут по cron, либо вручную.
# Локальный файл не трогается, если удалённая версия не новее (curl -z).
set -e

REPO="codemag33/yanpro-full"
ASSET="yanpro-driver.apk"
URL="https://github.com/${REPO}/releases/download/latest-apk/${ASSET}"

# Корень проекта (.. от каталога скрипта)
DIR="$(cd "$(dirname "$0")/.." && pwd)"
APK_DIR="${DIR}/apk"
DEST="${APK_DIR}/${ASSET}"
TMP="${DEST}.tmp"

mkdir -p "${APK_DIR}"

# -z: скачивать, только если серверная версия новее локальной
if curl -fsSL -z "${DEST}" -o "${TMP}" "${URL}"; then
  if [ ! -s "${TMP}" ]; then
    # curl -z молча пропускает, если ничего не изменилось — TMP будет пустым/отсутствовать
    rm -f "${TMP}"
    exit 0
  fi
  mv -f "${TMP}" "${DEST}"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) APK обновлён ($(du -h "${DEST}" | cut -f1))"
else
  rm -f "${TMP}"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ошибка скачивания APK (${URL})" >&2
  exit 1
fi
