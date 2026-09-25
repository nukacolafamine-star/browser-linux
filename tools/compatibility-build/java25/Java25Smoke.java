import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.concurrent.atomic.AtomicInteger;

public final class Java25Smoke {
    static long hotSum(int limit) {
        long value = 0;
        for (int i = 1; i <= limit; i++) value += i;
        return value;
    }

    public static void main(String[] args) throws Exception {
        long started = System.nanoTime();
        if (Runtime.version().feature() != 25) throw new AssertionError("Expected Java 25");
        if (!System.getProperty("os.name").equals("Linux")) throw new AssertionError("Expected Linux");
        byte[] pattern = new byte[65536];
        for (int i = 0; i < pattern.length; i++) pattern[i] = (byte) (i * 31 + 7);
        Path output = Path.of(args.length == 0 ? "/tmp/java25-proof.bin" : args[0]);
        Files.write(output, pattern);
        if (!Arrays.equals(pattern, Files.readAllBytes(output))) throw new AssertionError("File round trip");
        AtomicInteger threads = new AtomicInteger();
        Thread platform = Thread.ofPlatform().start(threads::incrementAndGet);
        Thread virtual = Thread.ofVirtual().start(threads::incrementAndGet);
        platform.join();
        virtual.join();
        if (threads.get() != 2) throw new AssertionError("Thread completion");
        for (int i = 0; i < 32; i++) {
            byte[] allocation = new byte[1024 * 1024];
            allocation[i] = (byte) i;
            if (allocation[i] != (byte) i) throw new AssertionError("Allocation");
        }
        System.gc();
        long total = 0;
        for (int i = 0; i < 20000; i++) total += hotSum(100);
        if (total != 101000000L) throw new AssertionError("Arithmetic");
        System.out.println("JAVA25_SMOKE_OK version=" + Runtime.version()
            + " arch=" + System.getProperty("os.arch")
            + " sha256=" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(pattern))
            + " maxHeapBytes=" + Runtime.getRuntime().maxMemory()
            + " elapsedMs=" + (System.nanoTime() - started) / 1000000);
        Files.readString(Path.of("/proc/self/status")).lines()
            .filter(line -> line.startsWith("VmRSS:") || line.startsWith("VmHWM:"))
            .forEach(System.out::println);
    }
}
