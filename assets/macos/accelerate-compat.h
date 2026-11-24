/* whisper.cpp (ggml-blas, ggml-cpu) unconditionally defines ACCELERATE_NEW_LAPACK
 * and ACCELERATE_LAPACK_ILP64 on Apple, which links cblas_sgemm$NEWLAPACK$ILP64
 * (macOS 13.3+ only) even when targeting macOS 11.0 or 10.15. Undefining them keeps
 * Apple Accelerate acceleration via classic cblas_sgemm, present on all macOS versions. */
#undef ACCELERATE_NEW_LAPACK
#undef ACCELERATE_LAPACK_ILP64
