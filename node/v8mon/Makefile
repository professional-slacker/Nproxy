# libv8mon.so — V8 mmap hook
.PHONY: all clean test

CFLAGS ?= -O2 -fPIC -Wall -Wextra
LDFLAGS = -shared -ldl

all: libv8mon.so

libv8mon.so: v8mon.c
	gcc $(CFLAGS) -o $@ v8mon.c $(LDFLAGS)

test: libv8mon.so
	@echo "=== test: hook loads and tracks memory ==="
	V8MON_LOG=1 LD_PRELOAD=./libv8mon.so node -e "console.log('node started'); const v8 = require('v8'); console.log('heap_limit:', (v8.getHeapStatistics().heap_size_limit/1024/1024).toFixed(0), 'MB');" 2>&1

test_pressure: libv8mon.so
	@echo "=== test: pressure detection ==="
	V8MON_THRESHOLD_MB=50 V8MON_LOG=1 LD_PRELOAD=./libv8mon.so node -e "const b = []; for(let i=0;i<20;i++){b.push(Buffer.alloc(64*1024*1024,0x41));} console.log('done');" 2>&1 | head -30

clean:
	rm -f libv8mon.so
