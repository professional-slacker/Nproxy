CC = gcc
CFLAGS = -shared -fPIC -O2 -Wall -Wextra
LDFLAGS = -ldl
TARGET = nproxy_ld.so

.PHONY: all clean install

all: $(TARGET)

$(TARGET): nproxy_ld.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

clean:
	rm -f $(TARGET)
