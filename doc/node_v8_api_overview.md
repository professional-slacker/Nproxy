# Node.js V8 API 設計概要

**ソース**: deps/v8/include/*.h (888KB, 25598行)
**分析日**: 2026-05-12

## 1. アーキテクチャ全体像

V8 APIは以下の階層構造を持つ:

```
v8::Platform          (OS抽象化層)
  └─ v8::Isolate      (分離VMインスタンス)
       ├─ v8::Context  (実行コンテキスト)
       ├─ v8::HandleScope (ハンドル管理)
       └─ GC関連コールバック
```

---

## 2. 主要クラス群

### v8::Platform (v8-platform.h)
スレッドプール、トレーシング、ページアロケータを提供するOS抽象化層。
Node.jsは `node::MultiIsolatePlatform` で実装。

```cpp
class Platform {
  // スケジューリング
  virtual std::shared_ptr<TaskRunner> GetForegroundTaskRunner(Isolate*);
  virtual void CallOnWorkerThread(std::unique_ptr<Task>);
  virtual void CallDelayedOnWorkerThread(std::unique_ptr<Task>, double delay_s);
  
  // ページ割当
  virtual v8::PageAllocator* GetPageAllocator();
  
  // トレーシング
  virtual tracing::TracingController* GetTracingController();
};
```

### v8::Isolate (v8-isolate.h)
V8 VMの隔離インスタンス。スレッドごとに1つのIsolateが紐づく。
Node.jsはワーカースレッドごとにIsolateを生成する。

```cpp
class Isolate {
  // 生成
  static Isolate* Allocate();
  static Isolate* New(const CreateParams& params);
  void Initialize();
  
  // 実行コンテキスト
  Local<Context> GetCurrentContext();
  void Enter();
  void Exit();
  
  // メモリ制御 ← nproxy NearHeapLimitCallback が関わる部分
  void AddNearHeapLimitCallback(NearHeapLimitCallback, void* data);
  void RemoveNearHeapLimitCallback(NearHeapLimitCallback, size_t heap_limit);
  void RequestGarbageCollectionForTesting(GCCallbackFlags);
  void LowMemoryNotification();
  void MemoryPressureNotification(MemoryPressureLevel level);
  
  // メモリ統計
  size_t NumberOfHeapSpaces();
  bool GetHeapSpaceStatistics(HeapSpaceStatistics* stats, size_t i);
  HeapStatistics GetHeapStatistics();
  size_t GetHeapLimit();
  
  // メモリ追跡
  void AdjustAmountOfExternalAllocatedMemory(int64_t change);
  
  // スタック制御
  void SetStackLimit(uintptr_t stack_limit);
  void SetPrepareStackTraceCallback(PrepareStackTraceCallback callback);
  
  // 割り込み
  void RequestInterrupt(InterruptCallback, void* data);
};
```

### v8::Context (v8-context.h)
JavaScript実行コンテキスト。グローバルオブジェクトのスコープを定義。
Node.jsは各Isolateに1つのDefaultContextを持つ。

```cpp
class Context {
  static Local<Context> New(Isolate* isolate, 
                            ExtensionConfiguration* extensions = nullptr,
                            MaybeLocal<ObjectTemplate> global_template = ...);
  Local<Object> Global();
  void SetEmbedderData(uint32_t index, Local<Value> value);
  Local<Value> GetEmbedderData(uint32_t index);
};
```

---

## 3. ハンドルシステム

V8のGC可動オブジェクトへの参照は全てハンドル経由。

| ハンドル型 | 寿命 | 用途 |
|-----------|------|------|
| `Local<T>` | HandleScope内 | 一時的参照（関数引数） |
| `Persistent<T>` | 明示的解放まで | ヒープ跨ぎ参照 |
| `Global<T>` | GC回収 | Persistentの近代的代替 |
| `TracedReference<T>` | GC追跡 | cppgc統合 |

```cpp
// HandleScope: スタック上のハンドル領域
{
  HandleScope scope(isolate);
  Local<String> s = String::NewFromUtf8(isolate, "hello");
  // scope破棄でsはGC可能に
}

// Global: 明示的寿命管理
Global<Function> persistent;
persistent.Reset(isolate, function);
// ... 使用後
persistent.Reset(); // 明示的解放
```

---

## 4. GCシステム

### GCタイプ
- **Scavenge**: 若い世代(minor GC)。頻繁、高速
- **Mark-Sweep-Compact**: 全世代(major GC)。低速だが断片化除去
- **Incremental Marking**: メインスレッドを止めずに段階的マーク

### GCコールバック

```cpp
// GC開始/終了フック
Isolate::SetGCBeginCallback(Isolate*, GCSeginCallback, void* data);
Isolate::SetGCEndCallback(Isolate*, GCEndCallback, void* data);

// 確保失敗時のGCトリガー (nproxy NearHeapLimitCallback の補完)
V8_WARN_UNUSED_RESULT bool IdleNotificationDeadline(double deadline_ms);

// 明示的GC通知
isolate->LowMemoryNotification();          // 低メモリ → GC促進
isolate->MemoryPressureNotification(       // メモリ圧迫レベル
    MemoryPressureLevel::kCritical);
```

### NearHeapLimitCallback（nproxy連携）

```cpp
using NearHeapLimitCallback = size_t (*)(void* data, 
                                          size_t current_heap_limit,
                                          size_t initial_heap_limit);

// V8がヒープ制限に近づいた時に発火
// current_heap_limit より大きい値を返すとV8は制限を拡張
// current_heap_limit 以下の値を返すと → OOM

void AddNearHeapLimitCallback(NearHeapLimitCallback callback, void* data);
void RemoveNearHeapLimitCallback(NearHeapLimitCallback callback, 
                                  size_t heap_limit);
```

**重要**: コールバック内で `LowMemoryNotification()` や `MemoryPressureNotification()` を呼ぶと再帰的にコールバックが発火する。nproxyではヒープ拡張のみを行い、JSスレッドにTSFNで非同期通知する。

---

## 5. JavaScript値のラッピング

### 基本型

```cpp
// 生成
Local<Primitive> v = Undefined(isolate);
Local<Boolean> b = Boolean::New(isolate, true);
Local<Number> n = Number::New(isolate, 3.14);
Local<String> s = String::NewFromUtf8(isolate, "text");
Local<Symbol> sym = Symbol::New(isolate, description);

// 変換
bool bval = b->Value();
double d = n->Value();
String::Utf8Value utf8(isolate, s);  // C文字列に
```

### オブジェクト

```cpp
Local<Object> obj = Object::New(isolate);
obj->Set(context, key, value);

Local<Array> arr = Array::New(isolate, length);
arr->Set(context, i, value);
arr->Length();

// プロトタイプ操作
obj->GetPrototype();
obj->SetPrototype(context, proto);
obj->GetInternalField(idx);
obj->SetInternalField(idx, value);
```

### 関数

```cpp
// C++関数をJSに公開
Local<FunctionTemplate> tmpl = FunctionTemplate::New(isolate, callback);
// インスタンス化
Local<Function> fn = tmpl->GetFunction(context);
fn->Call(context, recv, argc, argv);

// Promise
Local<Promise::Resolver> resolver = Promise::Resolver::New(context);
resolver->Resolve(context, value);
Local<Promise> promise = resolver->GetPromise();
```

---

## 6. ArrayBufferとBackingStore（メモリ管理）

```cpp
class ArrayBuffer : public Object {
  // 新しいバッファ作成
  static Local<ArrayBuffer> New(Isolate*, size_t byte_length);
  
  // 既存メモリをラップ
  static Local<ArrayBuffer> New(Isolate*, 
                                 std::shared_ptr<BackingStore> bs);
  static std::unique_ptr<BackingStore> NewBackingStore(
      void* data, size_t byte_length, DeleterCallback deleter, void* data);
  
  size_t ByteLength() const;
  void* Data() const;
  bool IsDetachable() const;
  void Detach(v8::Local<v8::Value> key);
  std::shared_ptr<BackingStore> GetBackingStore();
};

class BackingStore {
  void* Data() const;
  size_t ByteLength() const;
  size_t MaxByteLength() const;
  bool IsShared() const;
  bool IsResizableByUserJavaScript() const;
};
```

**バッファメモリの性質**: ArrayBufferのBackingStoreはC++ヒープに確保される。V8 GCの管理下ではなく、参照が切れた時にデストラクタで解放される。nproxyで言えば、`Buffer.alloc()` ではV8のold-spaceは圧迫されない。V8ヒープを圧迫するにはJS文字列の生成（`Buffer.toString('hex')` など）が必要。

---

## 7. 例外とエラー処理

```cpp
class TryCatch {
  TryCatch(Isolate*);
  bool HasCaught();
  Local<Value> Exception();
  Local<Value> StackTrace();
  void Reset();
  void SetVerbose(bool);  // true → 未catchも再スロー
};

class V8_EXPORT Message {
  Local<String> Get();
  Local<String> GetSourceLine();
  Local<StackTrace> GetStackTrace();
  int GetLineNumber();
  int GetStartPosition();
  int GetEndPosition();
  MaybeLocal<String> GetSource();
};

// カスタムエラーハンドラ
isolate->AddMessageListener(OnMessage);
isolate->SetCaptureStackTraceForUncaughtExceptions(true, limit);
```

---

## 8. Wasm対応

```cpp
// Wasmモジュールのコンパイルとインスタンス化
MaybeLocal<WasmModuleObject> Compile(Isolate*, 
                                      const uint8_t* data, size_t size);
MaybeLocal<WasmInstanceObject> Instantiate(Isolate*, 
                                            Local<WasmModuleObject>,
                                            Local<WasmModuleObject> imports);
// メモリ操作
WasmMemoryObject::New(Isolate*, 
                       std::shared_ptr<BackingStore>, int initial_pages);
```

---

## 9. スレッドセーフティ

| 機能 | スレッド安全性 |
|------|---------------|
| Isolate操作 | 単一スレッドのみ（作成スレッド） |
| Platform | スレッドセーフ（明示的保証） |
| BackingStore共有 | 共有ポインタでIsolate間共有可 |
| 割り込み | RequestInterruptで他スレッドから割込可 |
| 非同期タスク | Platform::CallOnWorkerThreadで並列実行 |
| Locker | Isolate単一スレッドアクセス保証 |

```cpp
class Locker {
  explicit Locker(Isolate*);
};

class Unlocker {
  explicit Unlocker(Isolate*);
};
```

---

## 10. 非推奨APIと移行パス

| 旧API | 新API | 理由 |
|-------|-------|------|
| `Persistent<T>` | `Global<T>` | GC追跡の改善 |
| `V8::SetFlagsFromString` | `V8::SetFlagsFromCommandLine` | 安定性 |
| `ArrayBuffer::New(v8::Isolate*, ...)` | `ArrayBuffer::MaybeNew(...)` | エラーハンドリング |
| `Script::Compile(context, source)` | `Script::Compile(context, source, options)` | コンパイルオプション分離 |
| `SetStackLimit(uintptr_t)` | `SetStackLimit(uintptr_t, StackLimitSource)` | 制限ソースの明示 |

---

## 11. Node.js独自の拡張

Node.jsはV8 APIに以下の拡張を追加:

- `node::MultiIsolatePlatform` — 複数Isolateに対応したPlatform実装
- `node::AddEnvironmentCleanupHook` — Isolate破棄時のクリーンアップ
- `InternalCallbackScope` — JSコールバック内のC++例外をNode.jsスタイルで処理
- `node::Environment` — Node.jsのランタイムコンテキスト（require, process等）

---

## 12. 代表的なコールバック型

```
GCSeginCallback     → void(Isolate*, GCCallbackFlags)
GCEndCallback       → void(Isolate*, GCCallbackFlags)
NearHeapLimitCallback → size_t(void*, size_t, size_t)
InterruptCallback   → void(Isolate*, void*)
PrepareStackTraceCallback → MaybeLocal<Value>(Local<Context>, Local<Array>)
PromiseRejectCallback → void(PromiseRejectMessage)
HostImportModuleDynamicallyCallback → MaybeLocal<Promise>(Local<Context>, Local<ScriptOrModule>, Local<String>)
HostInitializeImportMetaObjectCallback → void(Local<Context>, Local<Module>, Local<Object>)
*/

/* === 設計書 終わり === */
