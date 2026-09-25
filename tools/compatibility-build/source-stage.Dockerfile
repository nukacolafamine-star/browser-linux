# Append with prepare-sources.mjs. Run only on an isolated Linux runner.
# Reuses the exact compiled stage and retains generated files/relink objects.
FROM browser-linux-runtime-build AS browser-linux-runtime-sources-build
COPY --from=zlib-emscripten-dev /zlib /source-trees/zlib
COPY --from=libffi-emscripten-dev /libffi /source-trees/libffi
COPY --from=glib-emscripten-dev /glib /source-trees/glib
COPY --from=pixman-emscripten-dev /pixman /source-trees/pixman
COPY --from=glib-emscripten-dev /stub /source-trees/resolver-stub
COPY --from=glib-emscripten-dev /cross.meson /source-trees/build-config/cross.meson
COPY --from=glib-emscripten-dev /emcc-meson-wrap.sh /source-trees/build-config/emcc-meson-wrap.sh
COPY . /source-recipe
COPY collect-runtime-sources.py /tmp/collect-runtime-sources.py
RUN python3 /tmp/collect-runtime-sources.py

FROM scratch AS browser-linux-runtime-sources
COPY --from=browser-linux-runtime-sources-build /source-output/ /
