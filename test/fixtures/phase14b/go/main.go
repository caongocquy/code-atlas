package fixturego

import remote "example.com/remote"

type Reader interface {
	Dispatch() error
	Close() error
}

type FileReader struct{}
type NetReader struct{}

func (FileReader) Dispatch() error { return nil }
func (NetReader) Dispatch() error { return nil }
func (FileReader) Close() error { return nil }
func (NetReader) Close() error { return nil }

type Service struct {
	reader Reader
}

func (s *Service) Read() error { return nil }
func (s Service) Direct() { remote.Use(s.reader) }
func use(s *Service, r Reader) { s.Read(); r.Dispatch() }
