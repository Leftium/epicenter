# Encryption at Rest Is the Gold Standard

An important concept in security is encryption at rest. It means the data is encrypted all the way through: even when it's sitting in the database, it's fully encrypted. Not just while it's moving between your browser and a server (that's encryption in transit, which TLS handles), but always. At every point where data comes to rest on a disk somewhere, it's ciphertext.

This is how password managers work. When 1Password or Bitwarden store your vault, they don't just encrypt it during download. The vault is stored as ciphertext on their servers. If someone steals their entire database, they get encrypted blobs that are useless without your master password. The server never has the keys to decrypt what it's storing.

In Epicenter, the same principle applies to the API key vault. When you add an OpenAI key, encryption happens on your machine before the data goes anywhere:

```
USER TYPES API KEY: "sk-abc123..."
         │
    Client encrypts with AES-GCM
         │
         ▼
YJS DOCUMENT (in memory)
    val: { ct: "x8f2k...", iv: "m3n..." }
         │
         ├────────────────────────────┐
         ▼                            ▼
INDEXEDDB (local cache)        Y-SWEET SERVER (sync)
Ciphertext on disk.            Ciphertext in S3/R2.
    ENCRYPTED AT REST ✅         ENCRYPTED AT REST ✅
```

At every resting point—your local IndexedDB, the sync server, the S3 bucket—the actual API key is ciphertext. The key names (like `apiKey:openai`) are visible for indexing and conflict resolution, but the values are always encrypted. Someone with raw access to any of these storage layers sees noise.

This isn't full-document encryption, where the entire Yjs document would be opaque. The CRDT structure, metadata, and key names remain readable so sync and conflict resolution work normally. Only the sensitive values are encrypted. That's a deliberate tradeoff: we encrypt what matters and leave the plumbing visible so the system can function.

| Strategy                    | Protects Against                                   | Doesn't Protect Against                           |
| --------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| No encryption               | Nothing                                            | Network sniffing, database theft, physical access |
| Encryption in transit (TLS) | Network sniffing, man-in-the-middle                | Database theft, rogue admins, server compromise   |
| Encryption at rest          | Database theft, storage snapshots, physical access | Memory scraping on the active client              |

Some systems claim encryption at rest but don't quite get there. They encrypt the disk but leave database files readable to anyone with root access, or they encrypt the database but store the keys in a config file on the same server. That's not encryption at rest; that's encryption with the key taped to the lock.

The real test: if someone gets a full copy of your storage layer, can they read anything useful? If the answer is no, you have encryption at rest. If the answer is "well, they'd also need to find the key file," you don't.
