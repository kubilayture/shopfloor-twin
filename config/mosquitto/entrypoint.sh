#!/bin/sh
set -eu

passwd_file=/mosquitto/data/passwd
rm -f "$passwd_file"
touch "$passwd_file"
chmod 0700 "$passwd_file"

for entry in $MQTT_USERS; do
  mosquitto_passwd -b "$passwd_file" "${entry%%:*}" "${entry#*:}"
done
chown mosquitto:mosquitto "$passwd_file"

exec mosquitto -c /mosquitto/config/mosquitto.conf
