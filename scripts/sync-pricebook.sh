#!/usr/bin/env bash
# Pull the latest price book CSV from Proxmox RAG storage
# Run this after updating HCP's price book

PROXMOX="root@192.168.1.12"
KEY="C:/Users/carte/.ssh/id_ed25519_proxmox"
RAG_DIR="/mnt/samsung-sata/mav-rag/processed"
LOCAL="./data/pricebook.csv"

echo "Syncing price book from Proxmox..."

# Find the most recent pricebook export
REMOTE=$(ssh -i "$KEY" "$PROXMOX" "ls -t $RAG_DIR/*pricebook_export*.csv 2>/dev/null | head -1")

if [ -z "$REMOTE" ]; then
  echo "ERROR: No pricebook_export CSV found in $RAG_DIR"
  exit 1
fi

echo "Remote file: $REMOTE"
scp -i "$KEY" "$PROXMOX:$REMOTE" "$LOCAL"
echo "Done → $LOCAL"
