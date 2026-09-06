package journal

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// FileSink appends every event to a daily newline-delimited JSON file.
//
// The in-memory ring is for the dashboard; this is for afterwards. When a lot
// vanishes overnight or a source quietly stops answering, the answer has to
// survive the restart that follows, and it has to be readable by something
// other than the UI — grep, jq, or another pair of eyes.
type FileSink struct {
	dir string

	mu   sync.Mutex
	day  string
	file *os.File
	errs int
}

func NewFileSink(dir string) (*FileSink, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("journal dir: %w", err)
	}
	return &FileSink{dir: dir}, nil
}

// Path returns the file currently being written.
func (f *FileSink) Path() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return filepath.Join(f.dir, "journal-"+f.dayKey()+".ndjson")
}

// Dir returns the directory holding the daily files.
func (f *FileSink) Dir() string { return f.dir }

func (f *FileSink) dayKey() string { return time.Now().Format("2006-01-02") }

// Write appends one event. Failures are counted rather than propagated: the
// radar must keep trading data flowing even if the disk is unhappy.
func (f *FileSink) Write(e Event) {
	f.mu.Lock()
	defer f.mu.Unlock()

	day := f.dayKey()
	if f.file == nil || f.day != day {
		if f.file != nil {
			_ = f.file.Close()
		}
		path := filepath.Join(f.dir, "journal-"+day+".ndjson")
		file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			f.errs++
			return
		}
		f.file, f.day = file, day
	}

	line, err := json.Marshal(e)
	if err != nil {
		f.errs++
		return
	}
	if _, err := f.file.Write(append(line, '\n')); err != nil {
		f.errs++
	}
}

// Close releases the current file.
func (f *FileSink) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.file == nil {
		return nil
	}
	err := f.file.Close()
	f.file = nil
	return err
}

// Files lists the daily journals on disk, newest first.
func (f *FileSink) Files() []FileInfo {
	entries, err := os.ReadDir(f.dir)
	if err != nil {
		return nil
	}
	var out []FileInfo
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".ndjson" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, FileInfo{
			Name:     e.Name(),
			Bytes:    info.Size(),
			Modified: info.ModTime(),
		})
	}
	for i := 0; i < len(out); i++ {
		for j := i; j > 0 && out[j].Name > out[j-1].Name; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// FileInfo describes one journal file on disk.
type FileInfo struct {
	Name     string    `json:"name"`
	Bytes    int64     `json:"bytes"`
	Modified time.Time `json:"modified"`
}

// WriteErrors reports how many entries could not be written.
func (f *FileSink) WriteErrors() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.errs
}
