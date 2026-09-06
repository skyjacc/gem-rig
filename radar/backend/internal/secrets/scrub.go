// Package secrets removes credentials from text that is about to be shown,
// logged or handed to someone else.
//
// Steam's Web API takes its key in the query string, so every transport error
// Go produces carries it: a `*url.Error` prints the whole URL. That error text
// reached the dashboard, the journal, the daily NDJSON files and the diagnostic
// bundle — a file whose entire purpose is to be sent to someone else. Redacting
// at the point of download would have been too late; the key was already on
// disk.
//
// The rule this package exists to enforce: a secret is removed before it is
// recorded, not before it is shared.
package secrets

import "strings"

// Marker replaces a redacted value. It is deliberately visible: a reader must
// be able to tell that something was removed rather than never present.
const Marker = "[СКРЫТО]"

// minRedactable guards against scrubbing a value so short that it would match
// half the text. An empty or one-character "secret" is a misconfiguration, and
// blanking every occurrence of it would destroy the message instead of the key.
const minRedactable = 8

// Redactor holds the live secrets. They are read through functions because a
// key can be re-read from disk while the process runs.
type Redactor struct {
	sources []func() string
}

// New builds a redactor over the given secret providers. Nil providers are
// ignored, so a caller can pass an optional key without checking first.
func New(sources ...func() string) *Redactor {
	kept := make([]func() string, 0, len(sources))
	for _, s := range sources {
		if s != nil {
			kept = append(kept, s)
		}
	}
	return &Redactor{sources: kept}
}

// Static builds a redactor over fixed values, for tests and one-off callers.
func Static(values ...string) *Redactor {
	sources := make([]func() string, 0, len(values))
	for _, v := range values {
		v := v
		sources = append(sources, func() string { return v })
	}
	return &Redactor{sources: sources}
}

// String removes every known secret from s.
func (r *Redactor) String(s string) string {
	if r == nil || s == "" {
		return s
	}
	for _, source := range r.sources {
		v := source()
		if len(v) < minRedactable {
			continue
		}
		s = strings.ReplaceAll(s, v, Marker)
	}
	return s
}

// Error returns an error whose text carries no secrets.
//
// The original is kept as the wrapped cause so errors.Is still recognises
// context cancellation and the like; only the outer message is ever printed,
// and that one is clean.
func (r *Redactor) Error(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	clean := r.String(msg)
	if clean == msg {
		return err
	}
	return &scrubbed{msg: clean, cause: err}
}

type scrubbed struct {
	msg   string
	cause error
}

func (e *scrubbed) Error() string { return e.msg }
func (e *scrubbed) Unwrap() error { return e.cause }
