use serde_json::json;

use super::*;

/// A picture travels as a data URL a row can render, and the words beside it no longer spell
/// the part out: `[image]` marked a picture nothing drew, and this is the part that draws it.
#[test]
fn images_travel_as_data_urls_and_leave_the_text_alone() {
    let content = json!([
        { "type": "text", "text": "before" },
        { "type": "image", "data": "AAAA", "mimeType": "image/png" },
        { "type": "text", "text": "after" },
    ]);
    let images = content_images(Some(&content));
    assert_eq!(images.len(), 1);
    assert_eq!(images[0].mime_type, "image/png");
    assert_eq!(images[0].data_url, "data:image/png;base64,AAAA");
    // Three bytes per four base64 characters: a size label, not a decode.
    assert_eq!(images[0].bytes, 3);
    assert_eq!(content_text(Some(&content)), "before\nafter");
}

/// Only a part that says it is a picture of a kind a browser draws becomes one. A kind that is
/// missing or is not an image, an empty payload and a payload past the per-image ceiling are
/// all dropped whole rather than drawn wrong or cut in half.
#[test]
fn parts_that_are_not_drawable_images_are_dropped() {
    let oversized = "A".repeat(MAX_IMAGE_B64_BYTES + 1);
    let content = json!([
        { "type": "image", "data": oversized, "mimeType": "image/png" },
        { "type": "image", "data": "AAAA", "mimeType": "image/png" },
        { "type": "image", "data": "", "mimeType": "image/png" },
        { "type": "image", "data": "AAAA" },
        { "type": "image", "data": "AAAA", "mimeType": "application/pdf" },
        { "type": "text", "text": "words" },
    ]);
    let images = content_images(Some(&content));
    assert_eq!(images.len(), 1, "only the drawable part is a picture");
    assert_eq!(images[0].data_url, "data:image/png;base64,AAAA");
    // A payload that is not a content array has no parts to read at all.
    assert!(content_images(Some(&json!("plain text"))).is_empty());
    assert!(content_images(None).is_empty());
}

/// The gallery stops rather than grows: at the part count, and at the total budget - where a
/// part that would cross it ends the walk, so the parts behind it are not read either.
#[test]
fn the_gallery_stops_at_the_part_count_and_the_total_budget() {
    let part = json!({ "type": "image", "data": "AAAA", "mimeType": "image/png" });
    let many = Value::Array(vec![part; MAX_IMAGE_PARTS + 2]);
    assert_eq!(content_images(Some(&many)).len(), MAX_IMAGE_PARTS);

    // Two parts that each fit inside the per-image ceiling but leave less than a third of the
    // total budget: the third part crosses it, and the fourth is never read.
    let large = "A".repeat(MAX_IMAGE_B64_BYTES);
    let crossing = "A".repeat(MAX_IMAGES_TOTAL_B64_BYTES - 2 * MAX_IMAGE_B64_BYTES + 1);
    let content = json!([
        { "type": "image", "data": large, "mimeType": "image/png" },
        { "type": "image", "data": large.clone(), "mimeType": "image/png" },
        { "type": "image", "data": crossing, "mimeType": "image/png" },
        { "type": "image", "data": "AAAA", "mimeType": "image/png" },
    ]);
    assert_eq!(content_images(Some(&content)).len(), 2);
}
