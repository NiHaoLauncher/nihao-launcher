//! Release notes: the part of markdown (and the few HTML tags) that release descriptions on GitHub and GitLab
//! use, split into blocks the window can draw, plus the download of the images they point at.
// shortcut: line by line, so a tag or image split over several lines, tables, nested lists and links (shown as
// their text) are not understood; switch to a real markdown parser if releases start needing more.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::release;

/// Release notes with more images than this show the rest as their alt text.
const MAX_IMAGES: usize = 10;
/// A bigger image is not downloaded (an animated GIF is also decoded into memory frame by frame).
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, PartialEq)]
pub enum Block {
    Gap,
    Heading(String),
    Bullet(String),
    Text(String),
    /// An image with an absolute `https` address.
    Image { url: String, alt: String },
}

/// `host` is the release's host: GitLab descriptions refer to uploads by a path inside the project.
pub fn parse(notes: &str, host: &str) -> Vec<Block> {
    let base = (host == "GitLab").then_some(release::GITLAB_PROJECT);
    let (mut blocks, mut images) = (Vec::new(), 0);
    for line in notes.lines().map(str::trim) {
        let (make, body): (fn(String) -> Block, &str) = if line.starts_with('#') {
            (Block::Heading, line.trim_start_matches('#'))
        } else if let Some(item) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
            (Block::Bullet, item)
        } else {
            (Block::Text, line)
        };
        let (text, found) = split_images(body);
        let text = clean(&text);
        if !text.is_empty() {
            blocks.push(make(text));
        } else if line.is_empty() && blocks.last().is_some_and(|b| *b != Block::Gap) {
            blocks.push(Block::Gap);
        }
        for (url, alt) in found {
            images += 1;
            match absolute(&url, base) {
                Some(url) if images <= MAX_IMAGES => blocks.push(Block::Image { url, alt }),
                _ if !alt.is_empty() => blocks.push(Block::Text(format!("[{alt}]"))),
                _ => {}
            }
        }
    }
    blocks
}

/// `https` addresses stay as they are; a path is taken relative to `base` (the project, on GitLab); anything
/// else (`http`, `data:`, no base) is not fetched.
fn absolute(url: &str, base: Option<&str>) -> Option<String> {
    if url.starts_with("https://") {
        Some(url.to_string())
    } else if url.contains(':') || url.starts_with("//") {
        None
    } else {
        base.map(|base| format!("{base}/{}", url.trim_start_matches('/')))
    }
}

/// The line without its images, and the images as `(address, alt text)`: `![alt](url "title")` and `<img src=… alt=…>`.
fn split_images(line: &str) -> (String, Vec<(String, String)>) {
    let (mut rest, mut text, mut images) = (line, String::new(), Vec::new());
    while let Some(c) = rest.chars().next() {
        if let Some((url, alt, after)) = rest.strip_prefix("![").and_then(markdown_image) {
            images.push((url, alt));
            rest = after;
        } else if let Some((url, alt, after)) = html_image(rest) {
            images.push((url, alt));
            rest = after;
        } else {
            text.push(c);
            rest = &rest[c.len_utf8()..];
        }
    }
    (text, images)
}

/// `rest` follows the `![`: `alt](url "title")…`.
fn markdown_image(rest: &str) -> Option<(String, String, &str)> {
    let (alt, rest) = rest.split_once("](")?;
    let (inner, after) = rest.split_once(')')?;
    let url = inner.split_whitespace().next()?.trim_matches(['<', '>']);
    Some((url.to_string(), alt.to_string(), after))
}

/// `rest` starts at an `<img …>` tag that has a `src`.
fn html_image(rest: &str) -> Option<(String, String, &str)> {
    if !rest.as_bytes().get(..5)?.eq_ignore_ascii_case(b"<img ") {
        return None;
    }
    let (tag, after) = rest.split_once('>')?;
    Some((attribute(tag, "src")?, attribute(tag, "alt").unwrap_or_default(), after))
}

/// The value of `name="…"` (or `'…'`, or unquoted) inside a tag.
fn attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let start = lower.match_indices(&format!("{name}=")).map(|(i, _)| i).find(|&i| {
        lower[..i].ends_with(|c: char| c.is_whitespace())
    })? + name.len() + 1;
    let value = &tag[start..];
    match value.chars().next()? {
        quote @ ('"' | '\'') => value[1..].split_once(quote).map(|(v, _)| v.to_string()),
        _ => Some(value.split(|c: char| c.is_whitespace() || c == '/').next()?.to_string()),
    }
}

/// Plain text: no `**`/`` ` `` marks, no HTML tags, and `[text](url)` links shown as `text`.
fn clean(text: &str) -> String {
    let (mut out, mut rest) = (String::new(), text.replace("**", "").replace('`', ""));
    // HTML tags: `<` followed by a letter, `/` or `!` up to the next `>`; a lone `<` is text.
    while let Some(i) = rest.find('<') {
        let tag_like = rest[i + 1..].starts_with(|c: char| c.is_ascii_alphabetic() || c == '/' || c == '!');
        match rest[i..].find('>') {
            Some(j) if tag_like => {
                out.push_str(&rest[..i]);
                rest = rest[i + j + 1..].to_string();
            }
            _ => {
                out.push_str(&rest[..=i]);
                rest = rest[i + 1..].to_string();
            }
        }
    }
    out.push_str(&rest);
    let (mut plain, mut rest) = (String::new(), out.as_str());
    while let Some(i) = rest.find('[') {
        plain.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.split_once("](").and_then(|(label, tail)| Some((label, tail.split_once(')')?.1))) {
            Some((label, tail)) => {
                plain.push_str(label);
                rest = tail;
            }
            None => {
                plain.push('[');
                rest = after;
            }
        }
    }
    plain.push_str(rest);
    plain.trim().to_string()
}

/// Downloaded images by address. Cloning shares the same store; every image is requested once, on first use.
#[derive(Clone, Default)]
pub struct Images(Arc<Mutex<HashMap<String, Image>>>);

#[derive(Clone)]
pub enum Image {
    Loading,
    /// The file and its extension (what the format really is, whatever the address says).
    Ready(Arc<[u8]>, &'static str),
    Failed(String),
}

impl Images {
    /// The state of the image at `url`. The first call starts the download; `wake` runs when it is over.
    pub fn get(&self, url: &str, wake: impl FnOnce() + Send + 'static) -> Image {
        let mut images = self.0.lock().unwrap();
        if let Some(image) = images.get(url) {
            return image.clone();
        }
        images.insert(url.to_string(), Image::Loading);
        let (store, url) = (self.0.clone(), url.to_string());
        std::thread::spawn(move || {
            let result = load(&url).map_or_else(Image::Failed, |(data, ext)| Image::Ready(data, ext));
            store.lock().unwrap().insert(url, result);
            wake();
        });
        Image::Loading
    }
}

/// Downloads an image and checks that it is one the window can draw (PNG, JPEG, GIF).
fn load(url: &str) -> Result<(Arc<[u8]>, &'static str), String> {
    let data = release::download(url, MAX_IMAGE_BYTES, |_, _| {})?;
    let ext = if data.starts_with(b"GIF8") {
        "gif"
    } else if data.starts_with(b"\x89PNG") {
        "png"
    } else if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "jpg"
    } else {
        return Err("not a PNG, JPEG or GIF image".to_string());
    };
    Ok((data.into(), ext))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn image(url: &str, alt: &str) -> Block {
        Block::Image { url: url.into(), alt: alt.into() }
    }

    #[test]
    fn headings_bullets_and_marks_become_plain_blocks() {
        let blocks = parse("## Added\n- **Faster** start\n* a `code` bit\n\nPlain [link](https://x.y) text", "GitHub");
        assert_eq!(
            blocks,
            [
                Block::Heading("Added".into()),
                Block::Bullet("Faster start".into()),
                Block::Bullet("a code bit".into()),
                Block::Gap,
                Block::Text("Plain link text".into()),
            ]
        );
    }

    #[test]
    fn finds_markdown_and_html_images() {
        let notes = "![shot](https://a/b.png \"title\")\n\
                     <img width=\"300\" alt=\"Anim\" src=\"https://a/c.gif\" />\n\
                     <p align=\"center\"><img src='https://a/d.jpg'></p>\n\
                     - item ![in list](https://a/e.png)";
        assert_eq!(
            parse(notes, "GitHub"),
            [
                image("https://a/b.png", "shot"),
                image("https://a/c.gif", "Anim"),
                image("https://a/d.jpg", ""),
                Block::Bullet("item".into()),
                image("https://a/e.png", "in list"),
            ]
        );
    }

    #[test]
    fn a_badge_line_shows_its_image_and_no_leftovers() {
        assert_eq!(parse("[![build](https://a/badge.png)](https://a/ci)", "GitHub"), [image("https://a/badge.png", "build")]);
    }

    #[test]
    fn gitlab_uploads_are_relative_to_the_project_and_unsafe_addresses_are_not_fetched() {
        let notes = "![a](/uploads/abc/a.png)\n![b](http://insecure/b.png)\n![c](file:///c.png)\n![d](//cdn/d.png)";
        let github = parse(notes, "GitHub");
        assert_eq!(github, [Block::Text("[a]".into()), Block::Text("[b]".into()), Block::Text("[c]".into()), Block::Text("[d]".into())]);
        let gitlab = parse(notes, "GitLab");
        assert_eq!(gitlab[0], image(&format!("{}/uploads/abc/a.png", release::GITLAB_PROJECT), "a"));
        assert_eq!(&gitlab[1..], &github[1..]);
    }

    #[test]
    fn only_the_first_images_are_fetched() {
        let notes: String = (0..MAX_IMAGES + 2).map(|i| format!("![n{i}](https://a/{i}.png)\n")).collect();
        let blocks = parse(&notes, "GitHub");
        assert_eq!(blocks.iter().filter(|b| matches!(b, Block::Image { .. })).count(), MAX_IMAGES);
        assert_eq!(blocks.last(), Some(&Block::Text(format!("[n{}]", MAX_IMAGES + 1))));
    }

    #[test]
    fn a_lone_less_than_sign_is_text() {
        assert_eq!(parse("needs Java <= 17 and a<b", "GitHub"), [Block::Text("needs Java <= 17 and a<b".into())]);
    }

    fn serve(body: Vec<u8>) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/img", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let _ = conn.read(&mut [0u8; 1024]);
            write!(conn, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
            conn.write_all(&body).unwrap();
        });
        url
    }

    #[test]
    fn load_accepts_png_jpeg_and_gif_only() {
        let (data, ext) = load(&serve(b"GIF89a....".to_vec())).unwrap();
        assert_eq!((ext, data.len()), ("gif", 10));
        assert_eq!(load(&serve(b"\x89PNG\r\n\x1a\n".to_vec())).unwrap().1, "png");
        assert_eq!(load(&serve(vec![0xFF, 0xD8, 0xFF, 0xE0]).to_string()).unwrap().1, "jpg");
        assert!(load(&serve(b"<html>404</html>".to_vec())).is_err());
    }

    #[test]
    fn get_downloads_once_and_wakes_the_window() {
        let images = Images::default();
        let url = serve(b"GIF89a....".to_vec());
        let (tx, rx) = std::sync::mpsc::channel();
        assert!(matches!(images.get(&url, move || tx.send(()).unwrap()), Image::Loading));
        rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
        assert!(matches!(images.get(&url, || panic!("started a second download")), Image::Ready(_, "gif")));
    }
}
