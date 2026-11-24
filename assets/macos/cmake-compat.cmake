# Included via CMAKE_PROJECT_INCLUDE in .cargo/config.toml when CMake configures
# whisper.cpp. Using add_compile_options (rather than overriding CMAKE_C(XX)_FLAGS)
# preserves cc-rs flags such as -arch and -mmacosx-version-min.
if(APPLE AND NOT _LENS_MACOS_COMPAT_INCLUDED)
  set(_LENS_MACOS_COMPAT_INCLUDED TRUE)
  add_compile_options(
    "$<$<COMPILE_LANGUAGE:C,CXX>:-include>"
    "$<$<COMPILE_LANGUAGE:C,CXX>:${CMAKE_CURRENT_LIST_DIR}/accelerate-compat.h>"
  )
endif()
