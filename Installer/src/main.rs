#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod notes;
mod release;
#[path = "../../shared/release_lookup.rs"]
mod release_lookup;
#[path = "../../shared/release_sig.rs"]
mod release_sig;
mod setup;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use eframe::egui::{self, Align, Color32, CornerRadius, Layout, Margin, RichText, Stroke};
use notes::{Block, Image, Images};
use release::{Installed, Release};

/// The folder name the launcher is installed into by default and when a parent folder is browsed.
const FOLDER: &str = "NiHao Launcher";
/// The launcher's own icon (128 px: shown at exactly half size, so the pixel art stays sharp).
const ICON: &[u8] = include_bytes!("../assets/icon.png");

/// Program Files on Windows, the user's local data folder elsewhere.
fn default_dir() -> PathBuf {
    let program_files = if cfg!(windows) { std::env::var_os("ProgramFiles").map(PathBuf::from) } else { None };
    program_files.or_else(dirs::data_local_dir).unwrap_or_default().join(FOLDER)
}

// The launcher's dark greys and the blue of its banner.
const BG: Color32 = Color32::from_rgb(0x19, 0x19, 0x19);
const BAR: Color32 = Color32::from_rgb(0x20, 0x20, 0x20);
const CARD: Color32 = Color32::from_rgb(0x23, 0x23, 0x23);
const LINE: Color32 = Color32::from_rgb(0x3a, 0x3a, 0x3a);
const ACCENT: Color32 = Color32::from_rgb(0x4a, 0x90, 0xd9);
const MUTED: Color32 = Color32::from_rgb(0x9a, 0x9a, 0x9a);
const GOOD: Color32 = Color32::from_rgb(0x4c, 0xaf, 0x6a);
const BAD: Color32 = Color32::from_rgb(0xe8, 0x6e, 0x66);

/// The release lookup, which runs while the window is already open (its notes are shown before installing).
enum Latest {
    Loading,
    /// Newest first; the install tries them in this order.
    Found(Vec<Release>),
    Failed(String),
}

enum Stage {
    Ready,
    Working { text: String, done: u64, total: u64 },
    Done(Installed, Release),
    Failed(String),
}

struct App {
    dir: String,
    desktop_shortcut: bool,
    /// Whether this OS has a place to put shortcuts at all (not macOS).
    can_shortcut: bool,
    logo: egui::TextureHandle,
    images: Images,
    latest: Arc<Mutex<Latest>>,
    stage: Arc<Mutex<Stage>>,
}

impl App {
    fn new(ctx: &egui::Context, icon: &egui::IconData) -> Self {
        ctx.set_theme(egui::ThemePreference::Dark);
        style(ctx);
        egui_extras::install_image_loaders(ctx);
        let logo = egui::ColorImage::from_rgba_unmultiplied([icon.width as usize, icon.height as usize], &icon.rgba);
        let app = Self {
            dir: default_dir().display().to_string(),
            desktop_shortcut: true,
            can_shortcut: setup::Places::system().desktop.is_some(),
            logo: ctx.load_texture("logo", logo, egui::TextureOptions::NEAREST),
            images: Images::default(),
            latest: Arc::new(Mutex::new(Latest::Loading)),
            stage: Arc::new(Mutex::new(Stage::Ready)),
        };
        app.look_up(ctx);
        app
    }

    fn look_up(&self, ctx: &egui::Context) {
        *self.latest.lock().unwrap() = Latest::Loading;
        let (latest, ctx) = (self.latest.clone(), ctx.clone());
        std::thread::spawn(move || {
            *latest.lock().unwrap() = match release::latest() {
                Ok(releases) => Latest::Found(releases),
                Err(e) => Latest::Failed(e),
            };
            ctx.request_repaint();
        });
    }

    fn start(&self, ctx: &egui::Context) {
        let releases = match &*self.latest.lock().unwrap() {
            Latest::Found(releases) => releases.clone(),
            _ => return,
        };
        let dir = PathBuf::from(self.dir.trim());
        if let Err(e) = setup::check_dir(&dir) {
            *self.stage.lock().unwrap() = Stage::Failed(e);
            return;
        }
        let (stage, ctx, desktop) = (self.stage.clone(), ctx.clone(), self.desktop_shortcut);
        let set = move |s: Stage| {
            *stage.lock().unwrap() = s;
            ctx.request_repaint();
        };
        set(Stage::Working { text: "Starting…".into(), done: 0, total: 0 });
        std::thread::spawn(move || {
            if let Err(e) = setup::prepare_dir(&dir) {
                return set(Stage::Failed(e));
            }
            let result = release::install(&dir, releases, |text, done, total| {
                set(Stage::Working { text: text.into(), done, total })
            })
            .and_then(|(installed, release)| {
                set(Stage::Working { text: "Finishing setup…".into(), done: 0, total: 0 });
                setup::register(&installed, desktop, &setup::Places::system())
                    .map_err(|e| format!("Installed, but setup did not finish: {e}"))?;
                Ok((installed, release))
            });
            set(match result {
                Ok((installed, release)) => Stage::Done(installed, release),
                Err(e) => Stage::Failed(e),
            });
        });
    }
}

fn style(ctx: &egui::Context) {
    use egui::TextStyle;
    ctx.all_styles_mut(|s| {
        for (style, size) in [
            (TextStyle::Heading, 22.0),
            (TextStyle::Body, 14.5),
            (TextStyle::Button, 14.5),
            (TextStyle::Small, 12.0),
            (TextStyle::Monospace, 13.0),
        ] {
            s.text_styles.get_mut(&style).expect("default text style").size = size;
        }
        s.spacing.item_spacing = egui::vec2(8.0, 8.0);
        s.spacing.button_padding = egui::vec2(14.0, 6.0);
        s.spacing.interact_size.y = 30.0;
        let v = &mut s.visuals;
        (v.panel_fill, v.window_fill) = (BG, BG);
        v.extreme_bg_color = Color32::from_rgb(0x12, 0x12, 0x12);
        v.selection.bg_fill = ACCENT;
        v.selection.stroke = Stroke::new(1.5, ACCENT);
        v.widgets.noninteractive.fg_stroke.color = Color32::from_gray(0xd4);
        v.widgets.inactive.fg_stroke.color = Color32::from_gray(0xe6);
        v.widgets.inactive.weak_bg_fill = Color32::from_rgb(0x2e, 0x2e, 0x2e);
        v.widgets.hovered.weak_bg_fill = Color32::from_rgb(0x3b, 0x3b, 0x3b);
        for w in [&mut v.widgets.inactive, &mut v.widgets.hovered, &mut v.widgets.active] {
            w.corner_radius = CornerRadius::same(6);
        }
    });
}

fn primary(text: &str) -> egui::Button<'static> {
    egui::Button::new(RichText::new(text).strong().color(Color32::WHITE))
        .fill(ACCENT)
        .corner_radius(6)
        .min_size(egui::vec2(120.0, 34.0))
}

fn card() -> egui::Frame {
    egui::Frame::new().fill(CARD).stroke(Stroke::new(1.0, LINE)).corner_radius(8).inner_margin(Margin::same(12))
}

fn success_icon(ui: &mut egui::Ui) {
    let (rect, _) = ui.allocate_exact_size(egui::vec2(44.0, 44.0), egui::Sense::hover());
    let c = rect.center();
    ui.painter().circle_filled(c, 22.0, GOOD);
    let tick = [(-10.0, 0.0), (-3.0, 8.0), (11.0, -8.0)].map(|(x, y)| c + egui::vec2(x, y));
    ui.painter().line(tick.to_vec(), Stroke::new(3.5, Color32::WHITE));
}

/// The release description: headings, bullets and text, with the images it contains.
fn notes_ui(ui: &mut egui::Ui, release: &Release, images: &Images) {
    if release.notes.is_empty() {
        ui.label(RichText::new("No release notes were published for this version.").color(MUTED));
        return;
    }
    ui.spacing_mut().item_spacing.y = 4.0;
    for block in notes::parse(&release.notes, release.host) {
        match block {
            Block::Gap => ui.add_space(4.0),
            Block::Heading(text) => {
                ui.add_space(4.0);
                ui.label(RichText::new(text).strong().size(15.0).color(ACCENT));
            }
            Block::Bullet(text) => {
                ui.label(format!("•  {text}"));
            }
            Block::Text(text) => {
                ui.label(text);
            }
            Block::Image { url, alt } => image_ui(ui, &url, &alt, images),
        }
    }
}

/// An image from the notes, scaled down to the card's width (GIFs play).
fn image_ui(ui: &mut egui::Ui, url: &str, alt: &str, images: &Images) {
    let ctx = ui.ctx().clone();
    match images.get(url, move || ctx.request_repaint()) {
        Image::Ready(bytes, ext) => {
            let image = egui::Image::from_bytes(format!("bytes://{url}.{ext}"), bytes);
            ui.add(image.fit_to_original_size(1.0).max_width(ui.available_width()).corner_radius(6));
        }
        Image::Loading => {
            ui.horizontal(|ui| {
                ui.spinner();
                ui.label(RichText::new("Loading image…").color(MUTED));
            });
        }
        Image::Failed(why) => {
            let text = if alt.is_empty() { "(image could not be loaded)" } else { alt };
            ui.label(RichText::new(format!("[{text}]")).italics().color(MUTED)).on_hover_text(why);
        }
    }
}

fn notes_card(ui: &mut egui::Ui, release: &Release, images: &Images) {
    card().show(ui, |ui| {
        ui.set_min_size(ui.available_size());
        ui.horizontal(|ui| {
            ui.label(RichText::new(format!("What's new in {}", release.version)).strong().size(16.0).color(Color32::WHITE));
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.label(RichText::new(format!("from {}", release.host)).small().color(MUTED));
            });
        });
        egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
            ui.set_width(ui.available_width());
            notes_ui(ui, release, images);
        });
    });
}

fn section(ui: &mut egui::Ui, text: &str) {
    ui.label(RichText::new(text).strong().color(MUTED));
}

impl eframe::App for App {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let (mut install, mut browse, mut retry, mut launch, mut close) = (false, false, false, None, false);
        let stage = self.stage.lock().unwrap();
        let latest = self.latest.lock().unwrap();
        let newest = match &*latest {
            Latest::Found(releases) => releases.first(),
            _ => None,
        };

        egui::Panel::top("header").frame(egui::Frame::new().fill(BAR).inner_margin(Margin::symmetric(18, 14))).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.add(egui::Image::new(&self.logo).fit_to_exact_size(egui::vec2(64.0, 64.0)));
                ui.add_space(6.0);
                ui.vertical(|ui| {
                    ui.add_space(8.0);
                    ui.label(RichText::new("NiHao Launcher").size(24.0).strong().color(Color32::WHITE));
                    ui.label(RichText::new("Setup").color(MUTED));
                });
                if let Some(release) = newest {
                    ui.with_layout(Layout::right_to_left(Align::Min), |ui| {
                        card().inner_margin(Margin::symmetric(10, 4)).corner_radius(12).show(ui, |ui| {
                            ui.label(RichText::new(format!("v{}", release.version)).strong().color(ACCENT));
                        });
                    });
                }
            });
        });
        egui::Panel::top("accent").exact_size(2.0).frame(egui::Frame::new().fill(ACCENT)).show(ui, |_| {});

        egui::Panel::bottom("actions").frame(egui::Frame::new().fill(BAR).inner_margin(Margin::symmetric(18, 12))).show(ui, |ui| {
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| match &*stage {
                Stage::Ready | Stage::Failed(_) => {
                    install = ui.add_enabled(newest.is_some(), primary("Install")).clicked();
                }
                Stage::Working { .. } => {
                    ui.add_enabled(false, primary("Installing…"));
                }
                Stage::Done(installed, _) => {
                    if let Some(exe) = &installed.exe {
                        if ui.add(primary("Launch")).clicked() {
                            launch = Some(exe.clone());
                        }
                    }
                    close = ui.add(egui::Button::new("Close").min_size(egui::vec2(90.0, 34.0))).clicked();
                }
            });
        });

        // Controls sit above the buttons; the release notes take whatever height is left.
        let options = egui::Frame::new().fill(BG).inner_margin(Margin { left: 18, right: 18, top: 6, bottom: 14 });
        egui::Panel::bottom("options").frame(options).show(ui, |ui| match &*stage {
            Stage::Done(..) => {
                ui.label(
                    RichText::new(format!(
                        "To remove it, run {} in that folder{}.",
                        setup::UNINSTALLER,
                        if cfg!(windows) { " or use Settings > Apps" } else { "" }
                    ))
                    .small()
                    .color(MUTED),
                );
            }
            Stage::Working { text, done, total } => {
                ui.label(text);
                let bar = if *total > 0 {
                    egui::ProgressBar::new(*done as f32 / *total as f32).show_percentage()
                } else {
                    egui::ProgressBar::new(0.0).animate(true)
                };
                ui.add(bar.desired_height(16.0));
            }
            Stage::Ready | Stage::Failed(_) => {
                section(ui, "Install folder");
                ui.horizontal(|ui| {
                    let width = ui.available_width() - 90.0;
                    ui.add(egui::TextEdit::singleline(&mut self.dir).desired_width(width).margin(Margin::symmetric(8, 6)));
                    browse = ui.button("Browse…").clicked();
                });
                if self.can_shortcut {
                    ui.checkbox(&mut self.desktop_shortcut, "Create a desktop shortcut");
                }
            }
        });

        let central = egui::Frame::new().fill(BG).inner_margin(Margin { left: 18, right: 18, top: 16, bottom: 4 });
        egui::CentralPanel::default().frame(central).show(ui, |ui| {
            match &*stage {
                Stage::Done(installed, _) => {
                    ui.horizontal(|ui| {
                        success_icon(ui);
                        ui.vertical(|ui| {
                            ui.label(RichText::new(format!("Version {} is installed", installed.version)).strong().size(17.0));
                            ui.label(RichText::new(installed.dir.display().to_string()).monospace().color(MUTED));
                        });
                    });
                }
                Stage::Failed(e) => {
                    egui::Frame::new()
                        .fill(BAD.gamma_multiply(0.16))
                        .stroke(Stroke::new(1.0, BAD.gamma_multiply(0.6)))
                        .corner_radius(8)
                        .inner_margin(Margin::same(10))
                        .show(ui, |ui| {
                            ui.set_width(ui.available_width());
                            ui.label(RichText::new(e).color(BAD));
                        });
                }
                Stage::Ready | Stage::Working { .. } => {}
            }

            // What was installed, else the newest release found.
            let shown = match &*stage {
                Stage::Done(_, release) => Some(release),
                _ => newest,
            };
            match (&*latest, shown) {
                (_, Some(release)) => notes_card(ui, release, &self.images),
                (Latest::Failed(e), _) => {
                    card().show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        ui.label(RichText::new(format!("Could not find a release: {e}")).color(BAD));
                        retry = ui.button("Retry").clicked();
                    });
                }
                _ => {
                    card().show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        ui.horizontal(|ui| {
                            ui.spinner();
                            ui.label("Looking for the latest release…");
                        });
                    });
                }
            }
        });
        drop((stage, latest));

        if browse {
            if let Some(mut picked) = rfd::FileDialog::new().set_directory(&self.dir).pick_folder() {
                // The launcher gets a folder of its own inside the one picked (uninstalling deletes that folder).
                if picked.file_name().is_none_or(|name| name != FOLDER) {
                    picked.push(FOLDER);
                }
                self.dir = picked.display().to_string();
            }
        }
        if retry {
            self.look_up(ui.ctx());
        }
        if install {
            self.start(ui.ctx());
        }
        if let Some(exe) = launch {
            match std::process::Command::new(&exe).current_dir(exe.parent().unwrap_or(&exe)).spawn() {
                Ok(_) => close = true,
                Err(e) => *self.stage.lock().unwrap() = Stage::Failed(format!("Cannot start the launcher: {e}")),
            }
        }
        if close {
            ui.ctx().send_viewport_cmd(egui::ViewportCommand::Close);
        }
    }
}

fn uninstall_steps() -> Result<(), String> {
    if std::env::args().any(|a| a == "--apply") {
        return setup::apply();
    }
    if setup::start()? {
        return Ok(());
    }
    // The launcher is gone or damaged, so it can't ask what to keep: offer the plain way out.
    let answer = rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Warning)
        .set_title("NiHao Launcher uninstall")
        .set_description("The launcher cannot be opened to ask what to keep.

Delete everything in the install folder, including settings and any game data inside it?")
        .set_buttons(rfd::MessageButtons::YesNo)
        .show();
    if answer == rfd::MessageDialogResult::Yes {
        setup::remove_everything()?;
    }
    Ok(())
}

fn main() -> eframe::Result {
    // Started as `uninstall[.exe]` (the copy placed in the install folder): no window of its own. It
    // opens the launcher on its uninstall page (`start`); the launcher then runs it again with
    // `--apply` to delete what the user chose. Only a failure is shown, so a locked file doesn't go
    // unnoticed.
    if setup::is_uninstaller() {
        if let Err(e) = uninstall_steps() {
            rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Error)
                .set_title("NiHao Launcher uninstall")
                .set_description(e)
                .show();
        }
        return Ok(());
    }
    let icon = eframe::icon_data::from_png_bytes(ICON).expect("the embedded icon is a valid PNG");
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([560.0, 620.0])
            .with_resizable(false)
            .with_maximize_button(false)
            .with_icon(Arc::new(icon.clone())),
        ..Default::default()
    };
    eframe::run_native(
        "NiHao Launcher Installer",
        options,
        Box::new(move |cc| Ok(Box::new(App::new(&cc.egui_ctx, &icon)))),
    )
}
