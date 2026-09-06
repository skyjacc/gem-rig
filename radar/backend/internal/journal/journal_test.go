package journal

import (
	"encoding/json"
	"os"
	"strings"
	"sync"
	"testing"
)

func TestEventsAreNewestFirstAndFiltered(t *testing.T) {
	j := New(100)
	j.Info(KindFindingAdd, "lance", ReasonNewLot, "нашли лот", nil)
	j.Warn(KindSourceErr, "steam", "", "steam молчит", nil)
	j.Info(KindFindingDrop, "lance", ReasonDelisted, "лот ушёл", nil)

	all := j.Events(Query{})
	if len(all) != 3 || all[0].Kind != KindFindingDrop {
		t.Fatalf("newest first expected, got %d entries starting with %q", len(all), all[0].Kind)
	}

	// A dotted prefix selects a whole family.
	findings := j.Events(Query{Kind: "finding"})
	if len(findings) != 2 {
		t.Fatalf("prefix should match both finding events, got %d", len(findings))
	}

	warnings := j.Events(Query{Level: LevelWarn})
	if len(warnings) != 1 || warnings[0].Subject != "steam" {
		t.Fatalf("level filter should keep only the warning, got %+v", warnings)
	}

	bySubject := j.Events(Query{Subject: "LANCE"})
	if len(bySubject) != 2 {
		t.Fatalf("subject match should be case-insensitive, got %d", len(bySubject))
	}
}

func TestSinceIDStreamsOnlyNewEntries(t *testing.T) {
	j := New(100)
	j.Info(KindSweepStart, "", "", "первый", nil)
	seen := j.Events(Query{})[0].ID
	j.Info(KindSweepDone, "", "", "второй", nil)

	fresh := j.Events(Query{SinceID: seen})
	if len(fresh) != 1 || fresh[0].Message != "второй" {
		t.Fatalf("expected only the newer entry, got %+v", fresh)
	}
}

func TestRingBufferKeepsTheNewest(t *testing.T) {
	j := New(10)
	for i := 0; i < 50; i++ {
		j.Info(KindOrderBook, "x", "", "тик", map[string]any{"i": i})
	}
	if j.Size() != 10 {
		t.Fatalf("journal should retain its limit, got %d", j.Size())
	}
	newest := j.Events(Query{Limit: 1})
	if newest[0].Fields["i"] != 49 {
		t.Fatalf("oldest entries should be dropped, newest holds %v", newest[0].Fields["i"])
	}
}

func TestSubscribersReceiveEveryEvent(t *testing.T) {
	j := New(10)
	var mu sync.Mutex
	var got []string
	stop := j.Subscribe(func(e Event) {
		mu.Lock()
		got = append(got, e.Message)
		mu.Unlock()
	})
	j.Info(KindSweepStart, "", "", "раз", nil)
	stop()
	j.Info(KindSweepDone, "", "", "два", nil)

	mu.Lock()
	defer mu.Unlock()
	if len(got) != 1 || got[0] != "раз" {
		t.Fatalf("unsubscribed sink must stop receiving, got %v", got)
	}
}

func TestConcurrentWritesAreSafe(t *testing.T) {
	j := New(1000)
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for k := 0; k < 25; k++ {
				j.Debug(KindOrderBook, "x", "", "тик", nil)
			}
		}()
	}
	wg.Wait()
	if j.Size() != 1000 {
		t.Fatalf("expected the buffer to fill, got %d", j.Size())
	}
}

func TestFileSinkWritesOneLinePerEvent(t *testing.T) {
	dir := t.TempDir()
	sink, err := NewFileSink(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer sink.Close()

	j := New(10)
	j.Subscribe(sink.Write)
	j.Info(KindFindingAdd, "Lance", ReasonNewLot, "нашли", map[string]any{"price": 230})
	j.Warn(KindSourceErr, "steam", "", "молчит", nil)

	data, err := os.ReadFile(sink.Path())
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected one line per event, got %d", len(lines))
	}
	var first Event
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatalf("each line must be valid JSON on its own: %v", err)
	}
	if first.Subject != "Lance" || first.Fields["price"].(float64) != 230 {
		t.Fatalf("fields should survive the round trip, got %+v", first)
	}
	if files := sink.Files(); len(files) != 1 {
		t.Fatalf("expected one daily file, got %d", len(files))
	}
}

func TestFileSinkSurvivesAnUnwritableEvent(t *testing.T) {
	dir := t.TempDir()
	sink, _ := NewFileSink(dir)
	defer sink.Close()
	// A channel cannot be marshalled; the sink must count it and carry on.
	sink.Write(Event{ID: 1, Kind: KindAPIError, Fields: map[string]any{"bad": make(chan int)}})
	sink.Write(Event{ID: 2, Kind: KindSweepDone, Message: "ok"})

	if sink.WriteErrors() != 1 {
		t.Fatalf("the bad event should be counted once, got %d", sink.WriteErrors())
	}
	data, _ := os.ReadFile(sink.Path())
	if !strings.Contains(string(data), "sweep.done") {
		t.Fatal("the good event must still reach the file")
	}
}

// The journal is written to daily files and packed into a bundle meant to be
// sent to someone else. A credential that reaches it is a credential on disk,
// so scrubbing has to happen on the way in.
func TestSecretsAreScrubbedBeforeTheyAreRecorded(t *testing.T) {
	const key = "A1B2C3D4E5F60718293A4B5C6D7E8F90"
	j := New(10)
	j.Redact = func(s string) string { return strings.ReplaceAll(s, key, "[СКРЫТО]") }

	var sunk Event
	j.Subscribe(func(e Event) { sunk = e })

	j.Write(LevelError, "api.error", "steam?key="+key, "", `Get "https://api.steampowered.com/x?key=`+key+`": timeout`,
		map[string]any{
			"url":      "https://api.steampowered.com/x?key=" + key,
			"attempts": 3,
			"tried":    []string{"first?key=" + key, "second"},
		})

	stored := j.Events(Query{})
	if len(stored) != 1 {
		t.Fatalf("expected one event, got %d", len(stored))
	}
	for _, where := range []struct {
		what string
		text string
	}{
		{"message", stored[0].Message},
		{"subject", stored[0].Subject},
		{"field", stored[0].Fields["url"].(string)},
		{"slice field", strings.Join(stored[0].Fields["tried"].([]string), " ")},
		{"sink copy", sunk.Message},
	} {
		if strings.Contains(where.text, key) {
			t.Fatalf("the key survived in the %s: %s", where.what, where.text)
		}
	}
	// Redaction must not eat the rest of the payload.
	if stored[0].Fields["attempts"] != 3 {
		t.Fatalf("non-string fields must pass through untouched, got %v", stored[0].Fields["attempts"])
	}
	if !strings.Contains(stored[0].Message, "timeout") {
		t.Fatalf("the diagnosis must survive: %s", stored[0].Message)
	}
}

// Scrubbing copies the field map rather than editing the caller's.
func TestRedactionDoesNotMutateTheCallersFields(t *testing.T) {
	const key = "A1B2C3D4E5F60718293A4B5C6D7E8F90"
	j := New(10)
	j.Redact = func(s string) string { return strings.ReplaceAll(s, key, "x") }

	fields := map[string]any{"url": "?key=" + key}
	j.Write(LevelInfo, "k", "", "", "m", fields)

	if fields["url"] != "?key="+key {
		t.Fatalf("the caller's map was modified: %v", fields["url"])
	}
}
