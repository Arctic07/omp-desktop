//! The `ask` tool's HTML form, as the wire carries it.
//!
//! Split out of [`super`] when the form surface pushed that file past the bound
//! (`rules.md#single-file-line-limit`), the same way [`super::chat`], [`super::work`] and
//! [`super::stop`] were. Re-exported from [`super`], so every caller still names them through
//! `models::agent`.
//!
//! Since engine 18.18.3 the `ask` tool asks with one agent-written `<form>` instead of a
//! `questions[]` array (`tools/ask.ts`). The host parses it with the engine's own reader and sends
//! the document here: sections in order, each block by kind, each control answering into the
//! submitted data the tool reports to the model.

use serde::{Deserialize, Serialize};

/// One styled run of form text (`code`, `strong`, `em`, or plain).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct UiFormSpan {
    pub(crate) text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) style: Option<String>,
}

/// One answer of a choice field: the value the model receives, and the label the reader sees.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct UiFormOption {
    pub(crate) value: String,
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) checked: bool,
    #[serde(default)]
    pub(crate) disabled: bool,
}

/// A radio group, checkbox group or `<select>`: one question with its own answers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct UiFormChoice {
    pub(crate) name: String,
    /// A checkbox group or multi-select: the answer is an array.
    pub(crate) multi: bool,
    /// From a `<select>`: drawn as one row rather than an option list.
    pub(crate) select: bool,
    /// The UI adds a free-text "Other" answer for this group.
    pub(crate) other: bool,
    pub(crate) label: Vec<UiFormSpan>,
    pub(crate) options: Vec<UiFormOption>,
    #[serde(default)]
    pub(crate) required: bool,
}

/// A single-line `<input>` or a `<textarea>`, with the validation the model was promised.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct UiFormText {
    pub(crate) name: String,
    /// The `<input type>`, or `textarea`.
    #[serde(rename = "type")]
    pub(crate) kind: String,
    pub(crate) multiline: bool,
    pub(crate) label: Vec<UiFormSpan>,
    #[serde(default)]
    pub(crate) value: String,
    #[serde(default)]
    pub(crate) placeholder: String,
    #[serde(default)]
    pub(crate) required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) pattern: Option<String>,
    #[serde(default, rename = "minLength", skip_serializing_if = "Option::is_none")]
    pub(crate) min_length: Option<u64>,
    #[serde(default, rename = "maxLength", skip_serializing_if = "Option::is_none")]
    pub(crate) max_length: Option<u64>,
    #[serde(default)]
    pub(crate) rows: u64,
}

/// Any control the reader answers, tagged by `kind` as the host wrote it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum UiFormField {
    Choice(UiFormChoice),
    Text(UiFormText),
}

/// One renderable unit of a section, in document order.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum UiFormBlock {
    Text {
        spans: Vec<UiFormSpan>,
        #[serde(default)]
        heading: bool,
    },
    List {
        items: Vec<Vec<UiFormSpan>>,
        #[serde(default)]
        ordered: bool,
    },
    Pre {
        text: String,
    },
    Table {
        rows: Vec<Vec<Vec<UiFormSpan>>>,
        #[serde(default, rename = "headerRows")]
        header_rows: u64,
    },
    /// A picture the window loads itself: an `http(s)` URL or a `data:` URI. A local path arrives as
    /// text instead, because turning it into a URL would hand the webview a file read.
    Image {
        src: String,
        #[serde(default)]
        alt: String,
    },
    Svg {
        markup: String,
        #[serde(default)]
        alt: String,
    },
    Field {
        field: UiFormField,
    },
}

/// A `<fieldset>` (titled by its `<legend>`) or the loose content between fieldsets.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct UiFormSection {
    pub(crate) title: Vec<UiFormSpan>,
    pub(crate) blocks: Vec<UiFormBlock>,
}

/// One field's answer as the reader gave it: the control it addresses, and its value.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct UiFormAnswer {
    pub(crate) name: String,
    pub(crate) value: UiFormValue,
}

/// A submitted form value: text, a number for `number`/`range` inputs, or a group's checked values.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub(crate) enum UiFormValue {
    Text(String),
    Number(f64),
    Multiple(Vec<String>),
}
