//! The one renderer for screenshots that leave the notebook: every export, filing and agent tool
//! gets marks drawn and masks burned in here, so no path can hand out an unmasked screenshot.
use crate::protocol::{Point, Shape};
use tiny_skia::{FillRule, LineCap, LineJoin, Paint, PathBuilder, Pixmap, Rect, Stroke, Transform};

const LINE: f32 = 3.0;
const ARROW_HEAD: f32 = 14.0;

pub fn render(png: &[u8], shapes: &[Shape]) -> Result<Vec<u8>, String> {
    let mut pixmap =
        Pixmap::decode_png(png).map_err(|e| format!("the screenshot cannot be read: {e}"))?;
    let scale = text_scale(&pixmap);
    for shape in shapes {
        draw_mark(&mut pixmap, shape, scale);
    }
    // Blurs and masks last, over every mark, so nothing drawn can show through them; masks
    // after blurs, so a blur never averages black into what a mask left.
    for shape in shapes {
        if let Shape::Blur {
            x,
            y,
            width,
            height,
        } = shape
        {
            pixelate(&mut pixmap, *x, *y, *width, *height);
        }
    }
    for shape in shapes {
        if let Shape::Mask {
            x,
            y,
            width,
            height,
        } = shape
        {
            burn(&mut pixmap, *x, *y, *width, *height);
        }
    }
    pixmap
        .encode_png()
        .map_err(|e| format!("the screenshot cannot be written: {e}"))
}

/// A WebP shot with `areas` (fractions of its size) burned in as opaque black, written again as lossless WebP.
pub fn mask_webp(webp: &[u8], areas: &[crate::protocol::Area]) -> Result<Vec<u8>, String> {
    let mut decoder = image_webp::WebPDecoder::new(std::io::Cursor::new(webp))
        .map_err(|e| format!("the shot cannot be read: {e}"))?;
    let (width, height) = decoder.dimensions();
    // A few bytes can claim a huge image: a step shot is a viewport, never more than 64 MP.
    if u64::from(width) * u64::from(height) > 64 << 20 {
        return Err("the shot is too large".into());
    }
    let channels = if decoder.has_alpha() { 4 } else { 3 };
    let mut pixels = vec![0u8; width as usize * height as usize * channels];
    decoder
        .read_image(&mut pixels)
        .map_err(|e| format!("the shot cannot be read: {e}"))?;
    for a in areas {
        // Whole pixels, rounded outwards, as in `burn`.
        let (w, h) = (f64::from(width), f64::from(height));
        let (x, y, aw, ah) = (a.x * w, a.y * h, a.width * w, a.height * h);
        let clamp = |v: f64, max: f64| v.clamp(0.0, max) as usize;
        let (left, right) = (
            clamp(x.min(x + aw).floor(), w),
            clamp(x.max(x + aw).ceil(), w),
        );
        let (top, bottom) = (
            clamp(y.min(y + ah).floor(), h),
            clamp(y.max(y + ah).ceil(), h),
        );
        for y in top..bottom {
            let row = y * width as usize * channels;
            for x in left..right {
                let at = row + x * channels;
                pixels[at..at + 3].fill(0);
                if channels == 4 {
                    pixels[at + 3] = 255;
                }
            }
        }
    }
    let mut out = Vec::new();
    let color = if channels == 4 {
        image_webp::ColorType::Rgba8
    } else {
        image_webp::ColorType::Rgb8
    };
    image_webp::WebPEncoder::new(&mut out)
        .encode(&pixels, width, height, color)
        .map_err(|e| format!("the shot cannot be written: {e}"))?;
    Ok(out)
}

/// Whole pixels, rounded outwards and clipped to the image: left, top, right, bottom.
fn pixel_box(pixmap: &Pixmap, x: f64, y: f64, width: f64, height: f64) -> [usize; 4] {
    let (w, h) = (f64::from(pixmap.width()), f64::from(pixmap.height()));
    let clamp = |v: f64, max: f64| {
        if v.is_finite() {
            v.clamp(0.0, max) as usize
        } else {
            0
        }
    };
    [
        clamp(x.min(x + width).floor(), w),
        clamp(y.min(y + height).floor(), h),
        clamp(x.max(x + width).ceil(), w),
        clamp(y.max(y + height).ceil(), h),
    ]
}

/// Large blocks of one average color: text under them cannot be read back, as a soft blur can.
fn pixelate(pixmap: &mut Pixmap, x: f64, y: f64, width: f64, height: f64) {
    let [left, top, right, bottom] = pixel_box(pixmap, x, y, width, height);
    let block = (pixmap.width() as usize / 120).clamp(12, 48);
    let stride = pixmap.width() as usize * 4;
    let data = pixmap.data_mut();
    for by in (top..bottom).step_by(block) {
        for bx in (left..right).step_by(block) {
            let (ex, ey) = ((bx + block).min(right), (by + block).min(bottom));
            let mut sum = [0u64; 4];
            for y in by..ey {
                for x in bx..ex {
                    let at = y * stride + x * 4;
                    for c in 0..4 {
                        sum[c] += u64::from(data[at + c]);
                    }
                }
            }
            let count = ((ex - bx) * (ey - by)) as u64;
            // Premultiplied channels average to premultiplied channels.
            let mean = sum.map(|v| (v / count) as u8);
            for y in by..ey {
                for x in bx..ex {
                    let at = y * stride + x * 4;
                    data[at..at + 4].copy_from_slice(&mean);
                }
            }
        }
    }
}

/// Opaque black on whole pixels, without anti-aliasing: a partly covered edge pixel could still
/// show part of what is under it.
fn burn(pixmap: &mut Pixmap, x: f64, y: f64, width: f64, height: f64) {
    let (left, right) = (x.min(x + width).floor(), x.max(x + width).ceil());
    let (top, bottom) = (y.min(y + height).floor(), y.max(y + height).ceil());
    let Some(rect) = Rect::from_ltrb(left as f32, top as f32, right as f32, bottom as f32) else {
        return;
    };
    let mut paint = Paint::default();
    paint.set_color_rgba8(0, 0, 0, 255);
    paint.anti_alias = false;
    pixmap.fill_rect(rect, &paint, Transform::identity(), None);
}

fn draw_mark(pixmap: &mut Pixmap, shape: &Shape, scale: f32) {
    let (points, color, closed): (Vec<Point>, &str, bool) = match shape {
        Shape::Mask { .. } | Shape::Blur { .. } => return,
        Shape::Text { x, y, text, color } => {
            return draw_label(pixmap, *x as f32, *y as f32, text, color, scale);
        }
        Shape::Badge {
            x,
            y,
            number,
            color,
        } => return draw_badge(pixmap, *x as f32, *y as f32, *number, color, scale),
        Shape::Rectangle {
            x,
            y,
            width,
            height,
            color,
        } => (
            vec![
                Point { x: *x, y: *y },
                Point {
                    x: x + width,
                    y: *y,
                },
                Point {
                    x: x + width,
                    y: y + height,
                },
                Point {
                    x: *x,
                    y: y + height,
                },
            ],
            color,
            true,
        ),
        Shape::Arrow { from, to, color } => {
            draw_arrow_head(pixmap, *from, *to, color);
            (vec![*from, *to], color, false)
        }
        Shape::Pen { points, color } => (points.clone(), color, false),
    };
    let mut path = PathBuilder::new();
    let Some((first, rest)) = points.split_first() else {
        return;
    };
    path.move_to(first.x as f32, first.y as f32);
    for point in rest {
        path.line_to(point.x as f32, point.y as f32);
    }
    if closed {
        path.close();
    }
    let Some(path) = path.finish() else { return };
    let stroke = Stroke {
        width: LINE,
        line_cap: LineCap::Round,
        line_join: LineJoin::Round,
        ..Stroke::default()
    };
    pixmap.stroke_path(&path, &paint(color), &stroke, Transform::identity(), None);
}

fn draw_arrow_head(pixmap: &mut Pixmap, from: Point, to: Point, color: &str) {
    let angle = (to.y - from.y).atan2(to.x - from.x) as f32;
    let (x, y) = (to.x as f32, to.y as f32);
    let wing = |turn: f32| {
        (
            x - ARROW_HEAD * (angle + turn).cos(),
            y - ARROW_HEAD * (angle + turn).sin(),
        )
    };
    let mut path = PathBuilder::new();
    path.move_to(x, y);
    let (ax, ay) = wing(0.45);
    let (bx, by) = wing(-0.45);
    path.line_to(ax, ay);
    path.line_to(bx, by);
    path.close();
    if let Some(path) = path.finish() {
        pixmap.fill_path(
            &path,
            &paint(color),
            FillRule::Winding,
            Transform::identity(),
            None,
        );
    }
}

/// `#rrggbb`, validated when the shape was saved.
fn rgb(color: &str) -> [u8; 3] {
    let channel =
        |at: usize| u8::from_str_radix(color.get(at..at + 2).unwrap_or("00"), 16).unwrap_or(0);
    [channel(1), channel(3), channel(5)]
}

fn paint(color: &str) -> Paint<'static> {
    let [r, g, b] = rgb(color);
    let mut paint = Paint::default();
    paint.set_color_rgba8(r, g, b, 255);
    paint.anti_alias = true;
    paint
}

/// White text on dark colors, black on light ones.
fn ink(color: &str) -> &'static str {
    let [r, g, b] = rgb(color).map(f32::from);
    if 0.299 * r + 0.587 * g + 0.114 * b > 160.0 {
        "#000000"
    } else {
        "#ffffff"
    }
}

/// Font pixels per screenshot pixel: labels stay readable on a 4K screenshot too.
fn text_scale(pixmap: &Pixmap) -> f32 {
    (pixmap.width() / 500).clamp(2, 6) as f32
}

/// The 5x7 glyphs of printable ASCII, one byte per column, bit 0 at the top.
const FONT: [[u8; 5]; 95] = [
    [0x00, 0x00, 0x00, 0x00, 0x00],
    [0x00, 0x00, 0x5F, 0x00, 0x00],
    [0x00, 0x07, 0x00, 0x07, 0x00],
    [0x14, 0x7F, 0x14, 0x7F, 0x14],
    [0x24, 0x2A, 0x7F, 0x2A, 0x12],
    [0x23, 0x13, 0x08, 0x64, 0x62],
    [0x36, 0x49, 0x55, 0x22, 0x50],
    [0x00, 0x05, 0x03, 0x00, 0x00],
    [0x00, 0x1C, 0x22, 0x41, 0x00],
    [0x00, 0x41, 0x22, 0x1C, 0x00],
    [0x08, 0x2A, 0x1C, 0x2A, 0x08],
    [0x08, 0x08, 0x3E, 0x08, 0x08],
    [0x00, 0x50, 0x30, 0x00, 0x00],
    [0x08, 0x08, 0x08, 0x08, 0x08],
    [0x00, 0x60, 0x60, 0x00, 0x00],
    [0x20, 0x10, 0x08, 0x04, 0x02],
    [0x3E, 0x51, 0x49, 0x45, 0x3E],
    [0x00, 0x42, 0x7F, 0x40, 0x00],
    [0x42, 0x61, 0x51, 0x49, 0x46],
    [0x21, 0x41, 0x45, 0x4B, 0x31],
    [0x18, 0x14, 0x12, 0x7F, 0x10],
    [0x27, 0x45, 0x45, 0x45, 0x39],
    [0x3C, 0x4A, 0x49, 0x49, 0x30],
    [0x01, 0x71, 0x09, 0x05, 0x03],
    [0x36, 0x49, 0x49, 0x49, 0x36],
    [0x06, 0x49, 0x49, 0x29, 0x1E],
    [0x00, 0x36, 0x36, 0x00, 0x00],
    [0x00, 0x56, 0x36, 0x00, 0x00],
    [0x08, 0x14, 0x22, 0x41, 0x00],
    [0x14, 0x14, 0x14, 0x14, 0x14],
    [0x00, 0x41, 0x22, 0x14, 0x08],
    [0x02, 0x01, 0x51, 0x09, 0x06],
    [0x32, 0x49, 0x79, 0x41, 0x3E],
    [0x7E, 0x11, 0x11, 0x11, 0x7E],
    [0x7F, 0x49, 0x49, 0x49, 0x36],
    [0x3E, 0x41, 0x41, 0x41, 0x22],
    [0x7F, 0x41, 0x41, 0x22, 0x1C],
    [0x7F, 0x49, 0x49, 0x49, 0x41],
    [0x7F, 0x09, 0x09, 0x01, 0x01],
    [0x3E, 0x41, 0x41, 0x51, 0x32],
    [0x7F, 0x08, 0x08, 0x08, 0x7F],
    [0x00, 0x41, 0x7F, 0x41, 0x00],
    [0x20, 0x40, 0x41, 0x3F, 0x01],
    [0x7F, 0x08, 0x14, 0x22, 0x41],
    [0x7F, 0x40, 0x40, 0x40, 0x40],
    [0x7F, 0x02, 0x04, 0x02, 0x7F],
    [0x7F, 0x04, 0x08, 0x10, 0x7F],
    [0x3E, 0x41, 0x41, 0x41, 0x3E],
    [0x7F, 0x09, 0x09, 0x09, 0x06],
    [0x3E, 0x41, 0x51, 0x21, 0x5E],
    [0x7F, 0x09, 0x19, 0x29, 0x46],
    [0x46, 0x49, 0x49, 0x49, 0x31],
    [0x01, 0x01, 0x7F, 0x01, 0x01],
    [0x3F, 0x40, 0x40, 0x40, 0x3F],
    [0x1F, 0x20, 0x40, 0x20, 0x1F],
    [0x7F, 0x20, 0x18, 0x20, 0x7F],
    [0x63, 0x14, 0x08, 0x14, 0x63],
    [0x03, 0x04, 0x78, 0x04, 0x03],
    [0x61, 0x51, 0x49, 0x45, 0x43],
    [0x00, 0x7F, 0x41, 0x41, 0x00],
    [0x02, 0x04, 0x08, 0x10, 0x20],
    [0x00, 0x41, 0x41, 0x7F, 0x00],
    [0x04, 0x02, 0x01, 0x02, 0x04],
    [0x40, 0x40, 0x40, 0x40, 0x40],
    [0x00, 0x01, 0x02, 0x04, 0x00],
    [0x20, 0x54, 0x54, 0x54, 0x78],
    [0x7F, 0x48, 0x44, 0x44, 0x38],
    [0x38, 0x44, 0x44, 0x44, 0x20],
    [0x38, 0x44, 0x44, 0x48, 0x7F],
    [0x38, 0x54, 0x54, 0x54, 0x18],
    [0x08, 0x7E, 0x09, 0x01, 0x02],
    [0x0C, 0x52, 0x52, 0x52, 0x3E],
    [0x7F, 0x08, 0x04, 0x04, 0x78],
    [0x00, 0x44, 0x7D, 0x40, 0x00],
    [0x20, 0x40, 0x44, 0x3D, 0x00],
    [0x7F, 0x10, 0x28, 0x44, 0x00],
    [0x00, 0x41, 0x7F, 0x40, 0x00],
    [0x7C, 0x04, 0x18, 0x04, 0x78],
    [0x7C, 0x08, 0x04, 0x04, 0x78],
    [0x38, 0x44, 0x44, 0x44, 0x38],
    [0x7C, 0x14, 0x14, 0x14, 0x08],
    [0x08, 0x14, 0x14, 0x18, 0x7C],
    [0x7C, 0x08, 0x04, 0x04, 0x08],
    [0x48, 0x54, 0x54, 0x54, 0x20],
    [0x04, 0x3F, 0x44, 0x40, 0x20],
    [0x3C, 0x40, 0x40, 0x20, 0x7C],
    [0x1C, 0x20, 0x40, 0x20, 0x1C],
    [0x3C, 0x40, 0x30, 0x40, 0x3C],
    [0x44, 0x28, 0x10, 0x28, 0x44],
    [0x0C, 0x50, 0x50, 0x50, 0x3C],
    [0x44, 0x64, 0x54, 0x4C, 0x44],
    [0x00, 0x08, 0x36, 0x41, 0x00],
    [0x00, 0x00, 0x7F, 0x00, 0x00],
    [0x00, 0x41, 0x36, 0x08, 0x00],
    [0x08, 0x04, 0x08, 0x10, 0x08],
];

/// One glyph cell, with its gap: 6 by 8 font pixels.
const CELL: (f32, f32) = (6.0, 8.0);

/// ponytail: printable ASCII only, other characters show as `?`; a real font (fontdue) if labels
/// in other scripts matter.
fn draw_text(pixmap: &mut Pixmap, x: f32, y: f32, line: &str, color: &str, scale: f32) {
    let paint = Paint {
        anti_alias: false,
        ..paint(color)
    };
    for (n, c) in line.chars().enumerate() {
        let glyph = FONT[(c as usize)
            .checked_sub(32)
            .filter(|i| *i < 95)
            .unwrap_or(31)];
        let left = x + n as f32 * CELL.0 * scale;
        for (column, bits) in glyph.iter().enumerate() {
            for row in 0..7 {
                if (bits >> row) & 1 == 1
                    && let Some(rect) = Rect::from_xywh(
                        left + column as f32 * scale,
                        y + row as f32 * scale,
                        scale,
                        scale,
                    )
                {
                    pixmap.fill_rect(rect, &paint, Transform::identity(), None);
                }
            }
        }
    }
}

/// Lines of at most `width` characters, broken between words where it can.
fn wrap(text: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    for paragraph in text.lines() {
        let mut line = String::new();
        for word in paragraph.split_whitespace() {
            let mut word: Vec<char> = word.chars().collect();
            while !word.is_empty() {
                let used = line.chars().count();
                let room = width.saturating_sub(used + usize::from(used > 0));
                if word.len() <= room {
                    if used > 0 {
                        line.push(' ');
                    }
                    line.extend(word.drain(..));
                } else if used > 0 {
                    lines.push(std::mem::take(&mut line));
                } else {
                    line.extend(word.drain(..width));
                    lines.push(std::mem::take(&mut line));
                }
            }
        }
        lines.push(line);
    }
    lines
}

/// The text on a rounded pill of its color, the pill's top left corner at `x`, `y`.
fn draw_label(pixmap: &mut Pixmap, x: f32, y: f32, text: &str, color: &str, scale: f32) {
    let lines = wrap(text, 48);
    let longest = lines.iter().map(|l| l.chars().count()).max().unwrap_or(0) as f32;
    let pad = 3.0 * scale;
    let width = longest * CELL.0 * scale - scale + 2.0 * pad;
    let height = lines.len() as f32 * CELL.1 * scale - scale + 2.0 * pad;
    if let Some(pill) = rounded(x, y, width, height, 2.0 * scale) {
        pixmap.fill_path(
            &pill,
            &paint(color),
            FillRule::Winding,
            Transform::identity(),
            None,
        );
    }
    for (n, line) in lines.iter().enumerate() {
        let top = y + pad + n as f32 * CELL.1 * scale;
        draw_text(pixmap, x + pad, top, line, ink(color), scale);
    }
}

fn rounded(x: f32, y: f32, width: f32, height: f32, radius: f32) -> Option<tiny_skia::Path> {
    let r = radius.min(width / 2.0).min(height / 2.0);
    let (right, bottom) = (x + width, y + height);
    let mut path = PathBuilder::new();
    path.move_to(x + r, y);
    path.line_to(right - r, y);
    path.quad_to(right, y, right, y + r);
    path.line_to(right, bottom - r);
    path.quad_to(right, bottom, right - r, bottom);
    path.line_to(x + r, bottom);
    path.quad_to(x, bottom, x, bottom - r);
    path.line_to(x, y + r);
    path.quad_to(x, y, x + r, y);
    path.close();
    path.finish()
}

/// A filled circle with a white ring, the step number in its middle.
fn draw_badge(pixmap: &mut Pixmap, x: f32, y: f32, number: u32, color: &str, scale: f32) {
    let digits = number.to_string();
    let text_width = digits.len() as f32 * CELL.0 * scale - scale;
    let radius = (6.0 * scale).max(text_width / 2.0 + 2.0 * scale);
    for (r, fill) in [(radius + scale, "#ffffff"), (radius, color)] {
        if let Some(circle) = PathBuilder::from_circle(x, y, r) {
            pixmap.fill_path(
                &circle,
                &paint(fill),
                FillRule::Winding,
                Transform::identity(),
                None,
            );
        }
    }
    let (left, top) = (x - text_width / 2.0, y - 3.5 * scale);
    draw_text(
        pixmap,
        left.round(),
        top.round(),
        &digits,
        ink(color),
        scale,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_masked_shot_is_black_under_the_mask_only() {
        let (width, height) = (8u32, 4u32);
        let pixels = vec![200u8; (width * height * 3) as usize];
        let mut webp = Vec::new();
        image_webp::WebPEncoder::new(&mut webp)
            .encode(&pixels, width, height, image_webp::ColorType::Rgb8)
            .unwrap();
        let area = crate::protocol::Area {
            x: 1.5 / 8.0,
            y: 0.0,
            width: 0.25,
            height: 2.0,
        };
        let masked = mask_webp(&webp, &[area]).unwrap();
        let mut decoder = image_webp::WebPDecoder::new(std::io::Cursor::new(&masked)).unwrap();
        let mut out = vec![0u8; pixels.len()];
        decoder.read_image(&mut out).unwrap();
        let at = |x: usize, y: usize| out[(y * width as usize + x) * 3];
        assert_eq!((at(0, 0), at(1, 0), at(3, 3), at(4, 0)), (200, 0, 0, 200));
        assert!(mask_webp(b"not webp", &[area]).is_err());
    }

    fn white(width: u32, height: u32) -> Vec<u8> {
        let mut pixmap = Pixmap::new(width, height).unwrap();
        pixmap.fill(tiny_skia::Color::WHITE);
        pixmap.encode_png().unwrap()
    }

    fn pixel(png: &[u8], x: u32, y: u32) -> [u8; 4] {
        let pixmap = Pixmap::decode_png(png).unwrap();
        let p = pixmap.pixel(x, y).unwrap();
        [p.red(), p.green(), p.blue(), p.alpha()]
    }

    #[test]
    fn masks_cover_whole_pixels_and_sit_over_marks() {
        let shapes = [
            Shape::Mask {
                x: 4.5,
                y: 4.5,
                width: 3.0,
                height: 3.0,
            },
            Shape::Rectangle {
                x: 2.0,
                y: 2.0,
                width: 10.0,
                height: 10.0,
                color: "#ff3355".into(),
            },
        ];
        let out = render(&white(20, 20), &shapes).unwrap();
        // 4.5..7.5 covers pixels 4 to 7 entirely, edges included.
        for (x, y) in [(4, 4), (7, 7), (4, 7), (5, 5)] {
            assert_eq!(pixel(&out, x, y), [0, 0, 0, 255], "pixel {x},{y}");
        }
        assert_eq!(pixel(&out, 0, 0), [255, 255, 255, 255]);
        assert_ne!(
            pixel(&out, 2, 9),
            [255, 255, 255, 255],
            "the rectangle is drawn"
        );
    }

    #[test]
    fn handles_reversed_and_outside_shapes() {
        let shapes = [
            Shape::Mask {
                x: 30.0,
                y: 30.0,
                width: -40.0,
                height: -40.0,
            },
            Shape::Arrow {
                from: Point { x: -50.0, y: 1.0 },
                to: Point { x: 500.0, y: 9.0 },
                color: "#2f7bff".into(),
            },
            Shape::Pen {
                points: vec![],
                color: "#ffb000".into(),
            },
        ];
        let out = render(&white(20, 20), &shapes).unwrap();
        assert_eq!(pixel(&out, 19, 19), [0, 0, 0, 255]);
    }

    #[test]
    fn a_blur_leaves_one_color_per_block_and_nothing_outside() {
        // Black and white stripes one pixel wide: a 12 px block averages them to grey.
        let mut pixmap = Pixmap::new(40, 40).unwrap();
        pixmap.fill(tiny_skia::Color::WHITE);
        for x in (0..40).step_by(2) {
            burn(&mut pixmap, x as f64, 0.0, 1.0, 40.0);
        }
        let png = pixmap.encode_png().unwrap();
        let shapes = [
            Shape::Rectangle {
                x: 2.0,
                y: 2.0,
                width: 6.0,
                height: 6.0,
                color: "#ff0000".into(),
            },
            Shape::Blur {
                x: 0.0,
                y: 0.0,
                width: 12.0,
                height: 12.0,
            },
        ];
        let out = render(&png, &shapes).unwrap();
        let block = pixel(&out, 0, 0);
        for (x, y) in [(1, 1), (5, 11), (11, 0), (2, 2)] {
            assert_eq!(pixel(&out, x, y), block, "pixel {x},{y}");
        }
        assert!(
            block[0] > block[1],
            "the red mark under it is averaged in, not on top"
        );
        assert_eq!(pixel(&out, 12, 0), [0, 0, 0, 255]);
        assert_eq!(pixel(&out, 13, 0), [255, 255, 255, 255]);
        assert!(shapes[1].hides() && !shapes[0].hides());
    }

    #[test]
    fn a_label_is_a_pill_with_readable_text() {
        let shape = Shape::Text {
            x: 10.0,
            y: 10.0,
            text: "Hi".into(),
            color: "#2f7bff".into(),
        };
        let out = render(&white(100, 60), &[shape]).unwrap();
        // Scale 2: padding 6, so the H's left column runs down from (16, 16).
        assert_eq!(pixel(&out, 16, 16), [255, 255, 255, 255], "white ink");
        assert_eq!(pixel(&out, 13, 13), [0x2f, 0x7b, 0xff, 255], "the pill");
        assert_eq!(pixel(&out, 5, 5), [255, 255, 255, 255], "outside");
        assert_eq!(wrap("one two three", 7), ["one two", "three"]);
        assert_eq!(wrap("abcdefghij", 4), ["abcd", "efgh", "ij"]);
        assert_eq!(wrap("a\n\nb", 4), ["a", "", "b"]);
    }

    #[test]
    fn a_badge_is_a_circle_with_its_number() {
        let shape = Shape::Badge {
            x: 30.0,
            y: 30.0,
            number: 1,
            color: "#ffb000".into(),
        };
        let out = render(&white(60, 60), &[shape]).unwrap();
        // A light color gets black ink: the 1's stem is the glyph's third column.
        let (left, top) = (30 - 5, 30 - 7);
        assert_eq!(pixel(&out, left + 4, top + 4), [0, 0, 0, 255], "the digit");
        assert_eq!(
            pixel(&out, 30 - 9, 30),
            [0xff, 0xb0, 0x00, 255],
            "the circle"
        );
        assert_eq!(pixel(&out, 0, 0), [255, 255, 255, 255]);
        let bad = Shape::Badge {
            x: 0.0,
            y: 0.0,
            number: 0,
            color: "#ffb000".into(),
        };
        assert!(bad.validate().is_err());
    }

    #[test]
    fn refuses_what_is_not_a_png() {
        assert!(render(b"GIF89a", &[]).is_err());
    }
}
