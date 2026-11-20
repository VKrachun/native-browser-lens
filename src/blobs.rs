//! Content-addressed files: `blobs/<first two hex>/<sha256>`. Equal bytes are stored once, and a
//! blob never changes after it is written, so readers need no lock.
use crate::protocol::BlobRef;
use sha2::{Digest, Sha256};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

pub struct Blobs {
    root: PathBuf,
}

static TEMPORARY: AtomicU64 = AtomicU64::new(0);

impl Blobs {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn put(&self, bytes: &[u8], media_type: &str) -> io::Result<BlobRef> {
        let sha256: String = Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let path = self.path(&sha256)?;
        if !path.exists() {
            let folder = path.parent().expect("blob path has a folder");
            std::fs::create_dir_all(folder)?;
            let temporary = folder.join(format!(
                ".{sha256}.{}.{}",
                std::process::id(),
                TEMPORARY.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::write(&temporary, bytes)?;
            std::fs::rename(&temporary, &path)?;
        }
        Ok(BlobRef {
            sha256,
            size: bytes.len() as u64,
            media_type: media_type.into(),
        })
    }

    /// Up to `length` bytes from `offset`, and the blob's total size.
    pub fn read(&self, sha256: &str, offset: u64, length: u32) -> io::Result<(Vec<u8>, u64)> {
        let mut file = std::fs::File::open(self.path(sha256)?)?;
        let total = file.metadata()?.len();
        file.seek(SeekFrom::Start(offset.min(total)))?;
        let mut chunk = Vec::with_capacity(length.min(1 << 20) as usize);
        file.take(u64::from(length)).read_to_end(&mut chunk)?;
        Ok((chunk, total))
    }

    /// Moves a finished file into the store. The file is hashed as it is read, so a large
    /// recording never has to fit in memory.
    pub fn put_file(&self, file: &std::path::Path, media_type: &str) -> io::Result<BlobRef> {
        let mut hasher = Sha256::new();
        let mut reader = std::fs::File::open(file)?;
        let mut buffer = vec![0; 1 << 20];
        let mut size = 0u64;
        loop {
            let n = reader.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
            size += n as u64;
        }
        let sha256: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let path = self.path(&sha256)?;
        if path.exists() {
            std::fs::remove_file(file)?;
        } else {
            std::fs::create_dir_all(path.parent().expect("blob path has a folder"))?;
            if std::fs::rename(file, &path).is_err() {
                // Another volume: copy beside the blob, then rename, so a full disk never leaves a
                // partial file under the blob's name.
                let partial = path.with_extension("partial");
                if let Err(e) = std::fs::copy(file, &partial)
                    .and_then(|_| std::fs::File::open(&partial)?.sync_all())
                    .and_then(|()| std::fs::rename(&partial, &path))
                {
                    let _ = std::fs::remove_file(&partial);
                    return Err(e);
                }
                std::fs::remove_file(file)?;
            }
        }
        Ok(BlobRef {
            sha256,
            size,
            media_type: media_type.into(),
        })
    }

    /// Where a blob's file is, for a program that reads it directly.
    pub fn file(&self, sha256: &str) -> io::Result<PathBuf> {
        self.path(sha256)
    }

    pub fn read_all(&self, sha256: &str) -> io::Result<Vec<u8>> {
        std::fs::read(self.path(sha256)?)
    }

    fn path(&self, sha256: &str) -> io::Result<PathBuf> {
        let valid = sha256.len() == 64
            && sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !valid {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "not a sha256 in lowercase hex",
            ));
        }
        Ok(self.root.join(&sha256[..2]).join(sha256))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_once_and_reads_in_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let blobs = Blobs::new(dir.path().to_path_buf());
        let first = blobs.put(b"hello lens", "text/plain").unwrap();
        let again = blobs.put(b"hello lens", "text/plain").unwrap();
        assert_eq!(first, again);
        assert_eq!(
            std::fs::read_dir(dir.path().join(&first.sha256[..2]))
                .unwrap()
                .count(),
            1
        );

        assert_eq!(
            blobs.read(&first.sha256, 6, 100).unwrap(),
            (b"lens".to_vec(), 10)
        );
        assert_eq!(blobs.read(&first.sha256, 50, 4).unwrap(), (Vec::new(), 10));
    }

    #[test]
    fn refuses_paths_that_are_not_hashes() {
        let dir = tempfile::tempdir().unwrap();
        let blobs = Blobs::new(dir.path().to_path_buf());
        for bad in ["../../etc/passwd", "AB", &"G".repeat(64), &"a".repeat(63)] {
            assert_eq!(
                blobs.read(bad, 0, 1).unwrap_err().kind(),
                io::ErrorKind::InvalidInput
            );
        }
    }
}
