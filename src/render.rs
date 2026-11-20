//! The one renderer for screenshots that leave the notebook: every export, filing and agent tool
//! gets marks drawn and masks burned in here, so no path can hand out an unmasked screenshot.
use crate::protocol::{Point, Shape};
use tiny_skia::{FillRule, LineCap, LineJoin, Paint, PathBuilder, Pixmap, Rect, Stroke, Transform};

const LINE: f32 = 3.0;
const ARROW_HEAD: f32 = 14.0;

pub fn render(png: &[u8], shapes: &[Shape]) -> Result<Vec<u8>, String> {
    let mut pixmap =
        Pixmap::decode_png(png).map_err(|e| format!("the screenshot cannot be read: {e}"))?;
    for shape in shapes {
        draw_mark(&mut pixmap, shape);
    }
    // Masks last, over every mark, so nothing drawn can show through them.
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

fn draw_mark(pixmap: &mut Pixmap, shape: &Shape) {
    let (points, color, closed): (Vec<Point>, &str, bool) = match shape {
        Shape::Mask { .. } => return,
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
fn paint(color: &str) -> Paint<'static> {
    let channel =
        |at: usize| u8::from_str_radix(color.get(at..at + 2).unwrap_or("00"), 16).unwrap_or(0);
    let mut paint = Paint::default();
    paint.set_color_rgba8(channel(1), channel(3), channel(5), 255);
    paint.anti_alias = true;
    paint
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
    fn refuses_what_is_not_a_png() {
        assert!(render(b"GIF89a", &[]).is_err());
    }
}
