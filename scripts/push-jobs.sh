#!/usr/bin/env bash
PROXMOX="root@192.168.1.12"
KEY="C:/Users/carte/.ssh/id_ed25519_proxmox"
LOCAL="./data/jobs.csv"
REMOTE="/mnt/samsung-sata/mav-rag/hcp-exports/jobs.csv"

[ ! -f "$LOCAL" ] && echo "ERROR: $LOCAL not found" && exit 1
echo "Pushing jobs → Proxmox..."
scp -i "$KEY" "$LOCAL" "$PROXMOX:$REMOTE"
echo "Done."
