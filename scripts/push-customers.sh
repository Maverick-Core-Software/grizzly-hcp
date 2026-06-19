#!/usr/bin/env bash
PROXMOX="root@192.168.1.12"
KEY="C:/Users/carte/.ssh/id_ed25519_proxmox"
LOCAL="./data/customers.csv"
REMOTE="/mnt/samsung-sata/mav-rag/hcp-exports/customers.csv"

[ ! -f "$LOCAL" ] && echo "ERROR: $LOCAL not found" && exit 1
echo "Pushing customers → Proxmox..."
scp -i "$KEY" "$LOCAL" "$PROXMOX:$REMOTE"
echo "Done."
