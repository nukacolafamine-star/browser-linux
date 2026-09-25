[ -f ~/.bashrc ] && . ~/.bashrc
# Tell the browser page when the serial login shell is ready for input.
if [ "$(tty)" = /dev/ttyS0 ] && [ ! -e /run/browser-linux/serial-ready ]; then
  : > /run/browser-linux/serial-ready
  printf 'BROWSER_LINUX_SERIAL_READY\n'
fi
