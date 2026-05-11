{
  "targets": [
    {
      "target_name": "nheap_limit",
      "sources": ["nheap_limit.cc"],
      "include_dirs": [
        "<!(node -e \"console.log(require('path').dirname(require.resolve('node-addon-api/napi.h')))\")"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "defines": [ "NAPI_VERSION=9" ],
      "conditions": [
        ["OS=='linux'", {
          "cflags_cc": [ "-std=c++17" ]
        }]
      ]
    }
  ]
}
