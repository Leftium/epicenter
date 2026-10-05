/*
 * Atomically exchange two existing directory entries, for the replacements of
 * a Bun directory folder. `scripts/build-addon.ts` builds it;
 * `src/native-exchange.ts` loads and wraps it. Both paths must exist when the
 * exchange happens: when either is missing the call fails with ENOENT and
 * neither path changes.
 *
 * macOS: renamex_np(RENAME_SWAP). Linux: renameat2(RENAME_EXCHANGE), called
 * through syscall(2) so no particular C library version is required. Any
 * other platform does not compile. A filesystem that cannot exchange reports
 * its own errno (ENOTSUP, EINVAL, ENOSYS); nothing falls back to rename.
 *
 * `exchange(a, b)` returns 0 or the errno, and throws only for misuse.
 */
#define NAPI_VERSION 8

#if defined(__linux__)
#define _GNU_SOURCE
#endif

#include <errno.h>
#include <stdlib.h>
#include <string.h>

#include <node_api.h>

#if defined(__APPLE__)
#include <stdio.h>
#elif defined(__linux__)
#include <fcntl.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <unistd.h>
#ifndef RENAME_EXCHANGE
/* linux/fs.h; glibc before 2.28 does not define it. */
#define RENAME_EXCHANGE (1 << 1)
#endif
#else
#error "exchange.c supports macOS and Linux only"
#endif

static int exchange_paths(const char *a, const char *b) {
#if defined(__APPLE__)
	return renamex_np(a, b, RENAME_SWAP) == 0 ? 0 : errno;
#else
	return syscall(SYS_renameat2, AT_FDCWD, a, AT_FDCWD, b, RENAME_EXCHANGE) == 0
		? 0
		: errno;
#endif
}

/* A UTF-8 copy of a JavaScript string with no NUL inside, or NULL. */
static char *path_argument(napi_env env, napi_value value) {
	napi_valuetype type;
	if (napi_typeof(env, value, &type) != napi_ok || type != napi_string)
		return NULL;
	size_t length;
	if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok)
		return NULL;
	char *path = malloc(length + 1);
	if (path == NULL) return NULL;
	size_t copied;
	if (napi_get_value_string_utf8(env, value, path, length + 1, &copied) !=
			napi_ok ||
		copied != length || strlen(path) != length) {
		free(path);
		return NULL;
	}
	return path;
}

static napi_value exchange(napi_env env, napi_callback_info info) {
	size_t argc = 2;
	napi_value argv[2];
	if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
		argc != 2) {
		napi_throw_type_error(env, NULL, "exchange takes two paths");
		return NULL;
	}
	char *a = path_argument(env, argv[0]);
	char *b = a == NULL ? NULL : path_argument(env, argv[1]);
	if (a == NULL || b == NULL) {
		free(a);
		napi_throw_type_error(
			env, NULL, "exchange takes two paths without NUL characters");
		return NULL;
	}
	int code = exchange_paths(a, b);
	free(a);
	free(b);
	napi_value result;
	if (napi_create_int32(env, code, &result) != napi_ok) return NULL;
	return result;
}

NAPI_MODULE_INIT() {
	napi_value function;
	if (napi_create_function(env, "exchange", NAPI_AUTO_LENGTH, exchange, NULL,
			&function) != napi_ok ||
		napi_set_named_property(env, exports, "exchange", function) != napi_ok)
		return NULL;
	return exports;
}
