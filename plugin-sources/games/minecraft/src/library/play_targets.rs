//! Worlds (`saves/*`) and servers (`servers.dat`) of an instance, for the launch page's
//! "play straight into this" picker (see `MinecraftInstance::quick_play`).

use std::path::Path;

use serde_json::{json, Value};

/// Minimal NBT reader (enough for `servers.dat`): every value becomes JSON, number arrays and
/// floats are skipped over as `null`.
struct Nbt<'a>(&'a [u8]);

impl<'a> Nbt<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        if self.0.len() < n {
            return None;
        }
        let (head, tail) = self.0.split_at(n);
        self.0 = tail;
        Some(head)
    }
    fn int(&mut self) -> Option<i32> {
        Some(i32::from_be_bytes(self.take(4)?.try_into().ok()?))
    }
    fn string(&mut self) -> Option<String> {
        let len = u16::from_be_bytes(self.take(2)?.try_into().ok()?) as usize;
        Some(String::from_utf8_lossy(self.take(len)?).into_owned())
    }
    fn payload(&mut self, tag: u8, depth: u8) -> Option<Value> {
        if depth > 32 {
            return None;
        }
        Some(match tag {
            1 => json!(self.take(1)?[0] as i8),
            2 => json!(i16::from_be_bytes(self.take(2)?.try_into().ok()?)),
            3 => json!(self.int()?),
            4 => json!(i64::from_be_bytes(self.take(8)?.try_into().ok()?)),
            5 => {
                self.take(4)?;
                Value::Null
            }
            6 => {
                self.take(8)?;
                Value::Null
            }
            7 => {
                let n = self.int()?.max(0) as usize;
                self.take(n)?;
                Value::Null
            }
            8 => json!(self.string()?),
            9 => {
                let inner = self.take(1)?[0];
                let n = self.int()?.max(0);
                let mut items = Vec::new();
                for _ in 0..n {
                    items.push(self.payload(inner, depth + 1)?);
                }
                Value::Array(items)
            }
            10 => {
                let mut map = serde_json::Map::new();
                loop {
                    let t = self.take(1)?[0];
                    if t == 0 {
                        break;
                    }
                    let key = self.string()?;
                    map.insert(key, self.payload(t, depth + 1)?);
                }
                Value::Object(map)
            }
            11 => {
                let n = self.int()?.max(0) as usize;
                self.take(n * 4)?;
                Value::Null
            }
            12 => {
                let n = self.int()?.max(0) as usize;
                self.take(n * 8)?;
                Value::Null
            }
            _ => return None,
        })
    }
}

fn png_uri(b64: &str) -> String {
    format!("data:image/png;base64,{}", b64.trim())
}

/// Is the server answering a Minecraft "status" ping (handshake + status request)? Returns
/// `(online players, max players)`. shortcut: no SRV lookup, plain `host[:port]` only.
pub fn ping(addr: &str) -> Option<(i64, i64)> {
    use std::io::{Read, Write};
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;

    let (host, port) = match addr.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().ok()?),
        None => (addr, 25565),
    };
    let target = (host, port).to_socket_addrs().ok()?.next()?;
    let mut s = TcpStream::connect_timeout(&target, Duration::from_millis(1500)).ok()?;
    s.set_read_timeout(Some(Duration::from_millis(1500))).ok()?;

    fn varint(mut v: u32, out: &mut Vec<u8>) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(b);
                break;
            }
            out.push(b | 0x80);
        }
    }
    let mut body = vec![0u8];
    varint(765, &mut body);
    varint(host.len() as u32, &mut body);
    body.extend(host.as_bytes());
    body.extend(port.to_be_bytes());
    varint(1, &mut body);
    let mut packet = Vec::new();
    varint(body.len() as u32, &mut packet);
    packet.extend(body);
    packet.extend([1, 0]);
    s.write_all(&packet).ok()?;

    fn read_varint(s: &mut TcpStream) -> Option<u32> {
        let (mut v, mut shift) = (0u32, 0);
        loop {
            let mut b = [0u8];
            s.read_exact(&mut b).ok()?;
            v |= ((b[0] & 0x7f) as u32) << shift;
            if b[0] & 0x80 == 0 {
                return Some(v);
            }
            shift += 7;
            if shift > 28 {
                return None;
            }
        }
    }
    let len = read_varint(&mut s)? as usize;
    if len == 0 || len > 1 << 20 {
        return None;
    }
    if read_varint(&mut s)? != 0 {
        return None;
    }
    // Exactly the JSON, not `len` bytes: that counts the packet id and this length too, so asking for
    // it makes the read wait for bytes that never come, until the read timeout (1.5 s on every ping).
    let json_len = read_varint(&mut s)? as usize;
    if json_len > len {
        return None;
    }
    let mut json = Vec::new();
    s.take(json_len as u64).read_to_end(&mut json).ok();
    // The JSON can be cut short by the timeout; "online" is already proven by the valid header.
    let v: Value = serde_json::from_slice(&json).unwrap_or(Value::Null);
    Some((
        v["players"]["online"].as_i64().unwrap_or(0),
        v["players"]["max"].as_i64().unwrap_or(0),
    ))
}

/// `{ worlds: [{ folder, icon }] newest first, servers: [{ name, ip, icon }] }` (`icon` is a PNG
/// data URI or null). Missing/unreadable files just mean empty lists.
pub fn list(game_dir: &Path) -> Value {
    let mut worlds: Vec<(std::time::SystemTime, String, Option<String>)> = std::fs::read_dir(game_dir.join("saves"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let modified = e.path().join("level.dat").metadata().ok()?.modified().ok()?;
            let icon = std::fs::read(e.path().join("icon.png")).ok().map(|b| {
                use base64::Engine;
                png_uri(&base64::engine::general_purpose::STANDARD.encode(b))
            });
            Some((modified, e.file_name().to_string_lossy().into_owned(), icon))
        })
        .collect();
    worlds.sort_by(|a, b| b.0.cmp(&a.0));

    let servers: Vec<Value> = std::fs::read(game_dir.join("servers.dat"))
        .ok()
        .and_then(|bytes| {
            let mut nbt = Nbt(&bytes);
            if nbt.take(1)?[0] != 10 {
                return None;
            }
            nbt.string()?;
            nbt.payload(10, 0)
        })
        .and_then(|root| root.get("servers").cloned())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|s| {
            let ip = s.get("ip")?.as_str()?.to_string();
            let name = s.get("name").and_then(|n| n.as_str()).unwrap_or(&ip).to_string();
            let icon = s.get("icon").and_then(|i| i.as_str()).map(png_uri);
            Some(json!({ "name": name, "ip": ip, "icon": icon }))
        })
        .collect();

    json!({
        "worlds": worlds.into_iter().map(|w| json!({ "folder": w.1, "icon": w.2 })).collect::<Vec<_>>(),
        "servers": servers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A server answers the status request and then keeps the connection open, as real ones do.
    #[test]
    fn ping_returns_as_soon_as_the_status_arrived() {
        use std::io::{Read, Write};
        fn varint(mut v: usize, out: &mut Vec<u8>) {
            loop {
                let b = (v & 0x7f) as u8;
                v >>= 7;
                if v == 0 {
                    out.push(b);
                    break;
                }
                out.push(b | 0x80);
            }
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let server = std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let _ = conn.read(&mut [0u8; 64]);
            let json = br#"{"players":{"online":3,"max":20}}"#;
            let mut body = vec![0u8]; // packet id
            varint(json.len(), &mut body);
            body.extend_from_slice(json);
            let mut packet = Vec::new();
            varint(body.len(), &mut packet);
            packet.extend(body);
            conn.write_all(&packet).unwrap();
            std::thread::sleep(std::time::Duration::from_secs(3)); // does not hang up
        });
        let started = std::time::Instant::now();
        assert_eq!(ping(&addr), Some((3, 20)));
        assert!(started.elapsed() < std::time::Duration::from_millis(1000), "waited {:?}", started.elapsed());
        drop(server);
    }

    #[test]
    fn reads_servers_dat() {
        let mut b = vec![10, 0, 0, 9, 0, 7];
        b.extend(b"servers");
        b.extend([10, 0, 0, 0, 1]);
        for (k, v) in [("ip", "a.b:25565"), ("name", "A")] {
            b.extend([8, 0, k.len() as u8]);
            b.extend(k.as_bytes());
            b.extend([0, v.len() as u8]);
            b.extend(v.as_bytes());
        }
        b.extend([0, 0]);
        let dir = std::env::temp_dir().join("nh_play_targets_test");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("servers.dat"), b).unwrap();
        assert_eq!(list(&dir)["servers"], json!([{ "name": "A", "ip": "a.b:25565", "icon": null }]));
    }
}
