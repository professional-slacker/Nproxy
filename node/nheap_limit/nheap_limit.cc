#include <napi.h>
#include <v8-isolate.h>
#include <atomic>

struct NearHeapState {
  Napi::ThreadSafeFunction tsfn;
  std::atomic<bool> callback_pending{false};
  bool registered = false;
};

static NearHeapState* GetState() {
  // Singleton via module-level static — simpler and avoids env lifetime issues
  static NearHeapState st;
  return &st;
}

static constexpr double kHeapLimitGrowthFactor = 1.25;

static size_t NearHeapLimitCB(void* data, size_t current_heap_limit,
                               size_t initial_heap_limit) {
  (void)data;
  (void)initial_heap_limit;
  auto* st = GetState();

  // Re-entrancy guard + extend to survive
  if (st->callback_pending.exchange(true)) {
    return static_cast<size_t>(current_heap_limit * kHeapLimitGrowthFactor);
  }

  // ThreadSafeFunction is safe to call from any thread
  // This will invoke the JS callback on the main thread's event loop
  if (st->registered) {
    auto status = st->tsfn.BlockingCall();
    (void)status;
  }

  // Extend heap limit — V8 survives until JS callback runs
  return static_cast<size_t>(current_heap_limit * kHeapLimitGrowthFactor);
}

static Napi::Value Register(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "register(callback) requires a function")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  auto* st = GetState();
  if (st->registered) {
    Napi::Error::New(env, "register: already registered — call unregister() first")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Function jsCb = info[0].As<Napi::Function>();
  st->tsfn = Napi::ThreadSafeFunction::New(
      env, jsCb, "nheap_limit_cb", 0, 1,
      [](Napi::Env) { /* cleanup */ });
  st->registered = true;

  v8::Isolate::GetCurrent()->AddNearHeapLimitCallback(NearHeapLimitCB, nullptr);

  return Napi::Boolean::New(env, true);
}

static Napi::Value Unregister(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* st = GetState();
  if (st->registered) {
    v8::Isolate::GetCurrent()->RemoveNearHeapLimitCallback(NearHeapLimitCB, 0);
    st->tsfn.Release();
    st->registered = false;
  }
  return env.Undefined();
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("register", Napi::Function::New(env, Register));
  exports.Set("unregister", Napi::Function::New(env, Unregister));
  return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
