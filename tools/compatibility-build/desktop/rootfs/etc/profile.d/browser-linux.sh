export LANG=C.UTF-8
export EDITOR=nano
# OpenSSL finds each certificate authority in /etc/ssl/certs by its hash
# instead of parsing the whole 146-certificate bundle for every program.
# Under emulation that took seconds, and some servers (Mojang's among them)
# drop a TLS handshake that is not finished within about 5 seconds. The file
# holds one root certificate so that it loads; the directory holds them all.
export SSL_CERT_FILE=/etc/ssl/browser-linux-ca.pem SSL_CERT_DIR=/etc/ssl/certs
