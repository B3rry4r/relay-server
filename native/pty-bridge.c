/*
 * pty-bridge.c
 *
 * A minimal native PTY relay. Reads PTY output and writes to stdout in a
 * tight select() loop; reads stdin and forwards every byte to the PTY
 * UNCHANGED — no escape sequences, no framing, no in-band signaling.
 *
 * Resize events come on a separate control channel (file descriptor 3),
 * which Node attaches via the stdio[] array. Keeping resize off stdin
 * guarantees that arbitrary bytes a user can type into a terminal —
 * including 0x01 (Ctrl+A) and any escape sequence a TUI might send — are
 * forwarded to the shell verbatim.
 *
 * Build:
 *     gcc -O2 -Wall -Wextra -o pty-bridge pty-bridge.c -lutil
 *
 * Run:
 *     ./pty-bridge <shell> <cols> <rows>
 *
 * Protocol:
 *   stdin (fd 0) - keystrokes, forwarded to the PTY as-is.
 *   stdout (fd 1) - raw PTY output, no framing.
 *   stderr (fd 2) - bridge diagnostics on failure.
 *   ctrl  (fd 3) - 4-byte resize messages: cols_lo cols_hi rows_lo rows_hi (LE u16).
 *
 * Why this exists:
 *   The Node.js port (node-pty) fires onData callbacks on the JS thread for
 *   every PTY chunk. With heavy AI CLI streaming (claude, gemini, opencode)
 *   that is hundreds of callbacks per second, each allocating a JS string
 *   from native bytes. The resulting GC pressure freezes the JS event loop
 *   long enough to block other operations like socket emits and even
 *   keyboard input echo. Moving the PTY relay into a separate C process
 *   gets it off the JS event loop entirely; Node sees a normal child
 *   process whose stdout is a stream it can pipe.
 */

#define _XOPEN_SOURCE 600
#define _DEFAULT_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pty.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/select.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

#define IO_BUF_SIZE 8192
#define CTRL_FD     3

static volatile sig_atomic_t got_sigchld = 0;

static void on_sigchld(int sig) {
    (void)sig;
    got_sigchld = 1;
}

static void set_winsize(int fd, unsigned short cols, unsigned short rows) {
    struct winsize ws;
    memset(&ws, 0, sizeof(ws));
    ws.ws_col = cols;
    ws.ws_row = rows;
    ioctl(fd, TIOCSWINSZ, &ws);
}

/*
 * Drain `buf[0..len)` to `fd`, retrying on EINTR and on EAGAIN. Returns
 * 0 on success, -1 on unrecoverable error.
 */
static int write_all(int fd, const unsigned char *buf, size_t len) {
    size_t off = 0;
    while (off < len) {
        ssize_t n = write(fd, buf + off, len - off);
        if (n > 0) {
            off += (size_t)n;
            continue;
        }
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            fd_set wfds;
            FD_ZERO(&wfds);
            FD_SET(fd, &wfds);
            if (select(fd + 1, NULL, &wfds, NULL, NULL) < 0 && errno != EINTR) {
                return -1;
            }
            continue;
        }
        return -1;
    }
    return 0;
}

/*
 * Drain whatever resize messages are pending on the control channel and
 * apply only the latest valid one. Returns 0 on success, -1 if the
 * control fd was closed.
 */
static int drain_control_channel(int ctrl_fd, int pty_fd, unsigned char *carry, size_t *carry_len) {
    unsigned char buf[256];
    int closed = 0;
    int saw_resize = 0;
    unsigned short last_cols = 0, last_rows = 0;

    for (;;) {
        ssize_t n = read(ctrl_fd, buf, sizeof(buf));
        if (n > 0) {
            if (*carry_len + (size_t)n > 8) {
                /* Carry overflow shouldn't happen for 4-byte frames; reset. */
                *carry_len = 0;
            }
            memcpy(carry + *carry_len, buf, (size_t)n);
            *carry_len += (size_t)n;
            while (*carry_len >= 4) {
                last_cols = (unsigned short)carry[0] | ((unsigned short)carry[1] << 8);
                last_rows = (unsigned short)carry[2] | ((unsigned short)carry[3] << 8);
                memmove(carry, carry + 4, *carry_len - 4);
                *carry_len -= 4;
                saw_resize = 1;
            }
            continue;
        }
        if (n == 0) { closed = 1; break; }
        if (errno == EAGAIN || errno == EWOULDBLOCK) break;
        if (errno == EINTR) continue;
        closed = 1;
        break;
    }

    if (saw_resize && last_cols >= 1 && last_cols <= 1000 && last_rows >= 1 && last_rows <= 1000) {
        set_winsize(pty_fd, last_cols, last_rows);
    }
    return closed ? -1 : 0;
}

int main(int argc, char *argv[]) {
    const char *shell = (argc > 1 && argv[1][0]) ? argv[1] : "/bin/bash";
    unsigned short init_cols = (argc > 2) ? (unsigned short)atoi(argv[2]) : 80;
    unsigned short init_rows = (argc > 3) ? (unsigned short)atoi(argv[3]) : 24;
    if (init_cols == 0) init_cols = 80;
    if (init_rows == 0) init_rows = 24;

    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = on_sigchld;
    sa.sa_flags = SA_RESTART;
    sigaction(SIGCHLD, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);

    struct winsize ws;
    memset(&ws, 0, sizeof(ws));
    ws.ws_col = init_cols;
    ws.ws_row = init_rows;

    int master_fd = -1;
    pid_t child = forkpty(&master_fd, NULL, NULL, &ws);
    if (child < 0) {
        fprintf(stderr, "pty-bridge: forkpty failed: %s\n", strerror(errno));
        return 1;
    }

    if (child == 0) {
        /* Child: forkpty has already wired stdin/stdout/stderr to the PTY
         * slave. Close the inherited control fd so it doesn't leak into
         * the shell. */
        close(CTRL_FD);
        if (!getenv("TERM")) setenv("TERM", "xterm-256color", 1);
        execlp(shell, shell, (char *)NULL);
        /* Fall back to /bin/sh -c <shell> if execlp couldn't resolve the
         * shell path. */
        execlp("/bin/sh", "/bin/sh", "-c", shell, (char *)NULL);
        fprintf(stderr, "pty-bridge: exec %s failed: %s\n", shell, strerror(errno));
        _exit(127);
    }

    /* Detect whether fd 3 is connected (it is when Node wires it via
     * stdio[]). If not, we run without resize support — the bridge still
     * works for output streaming. */
    int ctrl_fd = CTRL_FD;
    int has_ctrl = (fcntl(ctrl_fd, F_GETFD) != -1) ? 1 : 0;

    int flags = fcntl(STDIN_FILENO, F_GETFL, 0);
    if (flags >= 0) fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK);
    flags = fcntl(master_fd, F_GETFL, 0);
    if (flags >= 0) fcntl(master_fd, F_SETFL, flags | O_NONBLOCK);
    if (has_ctrl) {
        flags = fcntl(ctrl_fd, F_GETFL, 0);
        if (flags >= 0) fcntl(ctrl_fd, F_SETFL, flags | O_NONBLOCK);
    }

    unsigned char buf[IO_BUF_SIZE];
    unsigned char ctrl_carry[8];
    size_t ctrl_carry_len = 0;
    int stdin_open = 1;
    int pty_open = 1;

    while (pty_open) {
        fd_set rfds;
        FD_ZERO(&rfds);
        if (stdin_open) FD_SET(STDIN_FILENO, &rfds);
        FD_SET(master_fd, &rfds);
        if (has_ctrl) FD_SET(ctrl_fd, &rfds);

        int nfds = master_fd;
        if (has_ctrl && ctrl_fd > nfds) nfds = ctrl_fd;
        if (STDIN_FILENO > nfds) nfds = STDIN_FILENO;
        nfds += 1;

        int ready = select(nfds, &rfds, NULL, NULL, NULL);
        if (ready < 0) {
            if (errno == EINTR) {
                if (got_sigchld) {
                    int status;
                    if (waitpid(child, &status, WNOHANG) > 0) {
                        for (;;) {
                            ssize_t n = read(master_fd, buf, sizeof(buf));
                            if (n <= 0) break;
                            write_all(STDOUT_FILENO, buf, (size_t)n);
                        }
                        pty_open = 0;
                    }
                    got_sigchld = 0;
                }
                continue;
            }
            break;
        }

        if (has_ctrl && FD_ISSET(ctrl_fd, &rfds)) {
            if (drain_control_channel(ctrl_fd, master_fd, ctrl_carry, &ctrl_carry_len) < 0) {
                close(ctrl_fd);
                has_ctrl = 0;
            }
        }

        if (stdin_open && FD_ISSET(STDIN_FILENO, &rfds)) {
            ssize_t n = read(STDIN_FILENO, buf, sizeof(buf));
            if (n > 0) {
                if (write_all(master_fd, buf, (size_t)n) < 0) break;
            } else if (n == 0) {
                stdin_open = 0;
                kill(child, SIGHUP);
            } else if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
                stdin_open = 0;
            }
        }

        if (FD_ISSET(master_fd, &rfds)) {
            for (;;) {
                ssize_t n = read(master_fd, buf, sizeof(buf));
                if (n > 0) {
                    if (write_all(STDOUT_FILENO, buf, (size_t)n) < 0) {
                        pty_open = 0;
                        break;
                    }
                    continue;
                }
                if (n == 0) { pty_open = 0; break; }
                if (errno == EAGAIN || errno == EWOULDBLOCK) break;
                if (errno == EINTR) continue;
                /* EIO on Linux means the child closed the slave. */
                pty_open = 0;
                break;
            }
        }
    }

    kill(child, SIGHUP);
    int status = 0;
    waitpid(child, &status, 0);
    close(master_fd);
    if (has_ctrl) close(ctrl_fd);

    if (WIFEXITED(status)) return WEXITSTATUS(status);
    return 0;
}
