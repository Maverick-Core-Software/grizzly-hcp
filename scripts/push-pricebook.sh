#!/usr/bin/env bash
# Push local pricebook.csv to the RAG ingest watch directory on Proxmox.
# The ingest service will pick it up automatically and index all items.

PROXMOX="root@192.168.1.12"
KEY="C:/Users/carte/.ssh/id_ed25519_proxmox"
LOCAL="./data/pricebook.csv"
REMOTE_DIR="/mnt/samsung-sata/mav-rag/hcp-exports"
REMOTE_FILE="$REMOTE_DIR/pricebook.csv"

if [ ! -f "$LOCAL" ]; then
  echo "ERROR: $LOCAL not found"
  exit 1
fi

echo "Pushing $LOCAL → $PROXMOX:$REMOTE_FILE"
scp -i "$KEY" "$LOCAL" "$PROXMOX:$REMOTE_FILE"
echo "Done — ingest service will index it within a few seconds."
