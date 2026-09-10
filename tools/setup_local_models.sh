#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  ClaudeCode-Portable - Local Model Setup (macOS/Linux)
# ═══════════════════════════════════════════════════════════

set -e

CYAN='\033[36m'; GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'
DIM='\033[90m'; MAGENTA='\033[35m'; BOLD='\033[1m'; RESET='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$ROOT_DIR/data"
ENV_FILE="$DATA_DIR/ai_settings.env"
MODELS_DIR="$DATA_DIR/models"
OLLAMA_DIR="$DATA_DIR/ollama"

OS_NAME=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

if [ "$OS_NAME" = "darwin" ]; then
    PLATFORM="darwin"
    OLLAMA_EXT="tgz"
    OLLAMA_URL="https://github.com/ollama/ollama/releases/latest/download/ollama-darwin.tgz"
elif [ "$OS_NAME" = "linux" ]; then
    PLATFORM="linux"
    OLLAMA_EXT="tar.zst"
    if ! command -v zstd >/dev/null 2>&1; then
        echo -e "${RED}[ERROR] zstd is not installed but is required to extract Ollama on Linux.${RESET}"
        echo -e "${YELLOW}Please install zstd (e.g. sudo apt install zstd) and try again.${RESET}"
        exit 1
    fi
    if [ "$ARCH" = "x86_64" ] || [ "$ARCH" = "amd64" ]; then
        OLLAMA_URL="https://github.com/ollama/ollama/releases/latest/download/ollama-linux-amd64.tar.zst"
    elif [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
        OLLAMA_URL="https://github.com/ollama/ollama/releases/latest/download/ollama-linux-arm64.tar.zst"
    else
        echo -e "${RED}Unsupported Linux architecture for Ollama: $ARCH${RESET}"
        exit 1
    fi
else
    echo -e "${RED}[ERROR] Unsupported OS: $OS_NAME${RESET}"
    exit 1
fi

OLLAMA_EXE="$OLLAMA_DIR/ollama-$PLATFORM"
[ "$PLATFORM" = "darwin" ] && OLLAMA_EXE="$OLLAMA_DIR/ollama"

echo ""
echo -e "${CYAN}=========================================================${RESET}"
echo -e "   ${BOLD}PORTABLE AI USB - Local Model Setup (macOS/Linux)${RESET}"
echo -e "${CYAN}=========================================================${RESET}"
echo ""

echo -e "${YELLOW}[1/4] Choose your AI model(s):${RESET}"
echo ""
echo -e "  --- ${CYAN}Gemma 4 Family (Optimized GGUFs)${RESET} ---"
echo -e "  ${YELLOW}[ 1]${RESET} Gemma 4 E2B (Q4_K_M)     ${CYAN}[Text]${RESET}         ${DIM}(~3.1 GB)${RESET}   ${GREEN}[STANDARD]${RESET} ${MAGENTA}- BEST BALANCE${RESET}"
echo -e "  ${YELLOW}[ 2]${RESET} Gemma 4 E2B (Q6_K)       ${CYAN}[Text]${RESET}         ${DIM}(~4.5 GB)${RESET}   ${GREEN}[STANDARD]${RESET} ${MAGENTA}- STRONG CPU/GPU${RESET}"
echo -e "  ${YELLOW}[ 3]${RESET} Gemma 4 E4B (Q4_K_M)     ${CYAN}[Text]${RESET}         ${DIM}(~5.0 GB)${RESET}   ${GREEN}[STANDARD]${RESET} ${MAGENTA}- MOST USERS${RESET}"
echo -e "  --- ${CYAN}Qwen 3.5 & Ministral 3 (Daily Drivers)${RESET} ---"
echo -e "  ${YELLOW}[ 4]${RESET} Qwen 3.5 (9B)            ${CYAN}[Text, Image]${RESET}  ${DIM}(~6.6 GB)${RESET}   ${GREEN}[STANDARD]${RESET} ${MAGENTA}- RECOMMENDED${RESET}"
echo -e "  ${YELLOW}[ 5]${RESET} Ministral 3 (8B)         ${CYAN}[Text, Image]${RESET}  ${DIM}(~6.0 GB)${RESET}   ${GREEN}[STANDARD]${RESET} ${MAGENTA}- DAILY${RESET}"

# --- Detect Already Downloaded Models (not in preset list) ---
MANIFEST_DIR="$OLLAMA_DIR/data/manifests/registry.ollama.ai/library"
declare -a DL_TAGS=()
declare -a DL_NAMES=()
DL_START_NUM=6

if [ -d "$MANIFEST_DIR" ]; then
    PRESET_SKIP="gemma-4-e2b-it-q4_k_m-local|gemma-4-e2b-it-q6_k-local|gemma-4-e4b-it-q4_k_m-local|qwen3.5|ministral-3"
    for model_dir in "$MANIFEST_DIR"/*/; do
        [ ! -d "$model_dir" ] && continue
        model_base=$(basename "$model_dir")
        for tag_file in "$model_dir"*; do
            [ -d "$tag_file" ] && continue
            [ ! -f "$tag_file" ] && continue
            tag_name=$(basename "$tag_file")
            if [ "$tag_name" = "latest" ]; then full_tag="$model_base"; else full_tag="$model_base:$tag_name"; fi
            # Skip presets
            echo "$full_tag" | grep -qE "$PRESET_SKIP" && continue
            # Get size from manifest JSON
            SIZE_BYTES=$(grep -o '"size"[[:space:]]*:[[:space:]]*[0-9]*' "$tag_file" 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')
            [ "${SIZE_BYTES:-0}" -lt 100000000 ] 2>/dev/null && continue
            SIZE_GB=$(awk "BEGIN {printf \"%.1f\", ${SIZE_BYTES:-0}/1073741824}")
            DL_TAGS+=("$full_tag")
            DL_NAMES+=("$full_tag")
        done
    done
fi

if [ ${#DL_TAGS[@]} -gt 0 ]; then
    echo -e "  --- ${GREEN}Already Downloaded${RESET} ---"
    for j in "${!DL_TAGS[@]}"; do
        NUM=$((DL_START_NUM + j))
        echo -e "  ${YELLOW}[$(printf '%2d' $NUM)]${RESET} $(printf '%-24s' "${DL_NAMES[$j]}") ${GREEN}[DOWNLOADED]${RESET}"
    done
fi

echo ""
echo -e "  ${GREEN}[C] CUSTOM - Enter an Official Ollama Tag${RESET}"
echo -e "      ${DIM}Browse ALL models here: ${CYAN}https://ollama.com/library${RESET}"
echo -e "  ${DIM}------------------------------------------------${RESET}"
echo -e "  ${DIM}Enter number(s) separated by commas (e.g. 1,5)${RESET}"
echo ""
read -p "  Your choice: " USER_CHOICE

if [ -z "$USER_CHOICE" ]; then
    echo -e "\n  ${YELLOW}No input! Defaulting to [3] Gemma 4 E4B...${RESET}"
    USER_CHOICE="3"
fi

declare -a SELECTED_MODELS
declare -a SELECTED_NAMES
declare -a SELECTED_TAGS
HAS_CUSTOM=0
CUSTOM_TAG=""

IFS=',' read -ra TOKENS <<< "$USER_CHOICE"
for T in "${TOKENS[@]}"; do
    T=$(echo "$T" | tr '[:upper:]' '[:lower:]' | tr -d ' \r\n')
    if [ "$T" = "c" ] || [ "$T" = "custom" ]; then
        HAS_CUSTOM=1
    elif [ "$T" = "1" ]; then SELECTED_MODELS+=("$T"); SELECTED_NAMES+=("Gemma 4 E2B (Q4_K_M)"); SELECTED_TAGS+=("https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf")
    elif [ "$T" = "2" ]; then SELECTED_MODELS+=("$T"); SELECTED_NAMES+=("Gemma 4 E2B (Q6_K)"); SELECTED_TAGS+=("https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q6_K.gguf")
    elif [ "$T" = "3" ]; then SELECTED_MODELS+=("$T"); SELECTED_NAMES+=("Gemma 4 E4B (Q4_K_M)"); SELECTED_TAGS+=("https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf")
    elif [ "$T" = "4" ]; then SELECTED_MODELS+=("$T"); SELECTED_NAMES+=("Qwen 3.5 (9B)"); SELECTED_TAGS+=("qwen3.5:9b")
    elif [ "$T" = "5" ]; then SELECTED_MODELS+=("$T"); SELECTED_NAMES+=("Ministral 3 (8B)"); SELECTED_TAGS+=("ministral-3:8b")
    else
        # Check if T is a number in the downloaded models range
        IS_DL=0
        if [ -n "$T" ] && [ "$T" -eq "$T" ] 2>/dev/null && [ "$T" -ge "$DL_START_NUM" ]; then
            idx=$((T - DL_START_NUM))
            if [ "$idx" -ge 0 ] && [ "$idx" -lt "${#DL_TAGS[@]}" ]; then
                SELECTED_MODELS+=("$T")
                SELECTED_NAMES+=("${DL_NAMES[$idx]}")
                SELECTED_TAGS+=("${DL_TAGS[$idx]}")
                IS_DL=1
            fi
        fi
        if [ "$IS_DL" -eq 0 ]; then
            echo -e "  ${RED}Unrecognized input: $T${RESET}"
        fi
    fi
done

if [ "$HAS_CUSTOM" -eq 1 ]; then
    echo ""
    echo -e "${GREEN}  ---- Custom Model Setup ----${RESET}"
    read -p "  Ollama Tag (e.g. mistral-nemo, phi3): " CUSTOM_TAG
    if [ -n "$CUSTOM_TAG" ]; then
        SELECTED_MODELS+=("99")
        SELECTED_NAMES+=("Custom: $CUSTOM_TAG")
        SELECTED_TAGS+=("$CUSTOM_TAG")
        echo -e "  ${GREEN}Custom model added!${RESET}"
    fi
fi

if [ ${#SELECTED_MODELS[@]} -eq 0 ]; then
    echo -e "\n  ${RED}ERROR: No models selected!${RESET}"
    exit 1
fi

FREE_KB=$(df -k "$DATA_DIR" 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "$FREE_KB" ]; then
    FREE_GB=$((FREE_KB / 1024 / 1024))
    echo -e "\n  ${DIM}USB Free Space: ~${FREE_GB} GB${RESET}"
    if [ "$FREE_GB" -lt 5 ]; then
        echo -e "  ${RED}WARNING: You have very low disk space (${FREE_GB} GB). Models may fail to download.${RESET}"
        read -p "  Continue anyway? (y/N): " CONT
        [[ ! "$CONT" =~ ^[Yy]$ ]] && exit 1
    fi
fi

mkdir -p "$MODELS_DIR" "$OLLAMA_DIR/data"
echo -e "\n${GREEN}[2/4] Created storage folders.${RESET}"

echo -e "\n${YELLOW}[3/4] Setting up Portable Ollama Engine...${RESET}"
if [ -x "$OLLAMA_EXE" ]; then
    echo -e "      ${GREEN}Engine already installed!${RESET}"
else
    echo -e "      ${YELLOW}Downloading Ollama Engine ($PLATFORM)...${RESET}"
    curl -L "$OLLAMA_URL" -o "$OLLAMA_DIR/ollama.$OLLAMA_EXT"
    if [ -f "$OLLAMA_DIR/ollama.$OLLAMA_EXT" ]; then
        echo -e "      ${YELLOW}Extracting...${RESET}"
        tar -xf "$OLLAMA_DIR/ollama.$OLLAMA_EXT" -C "$OLLAMA_DIR" 2>/dev/null
        rm -f "$OLLAMA_DIR/ollama.$OLLAMA_EXT"
        
        # If it extracts as bin/ollama, move it
        if [ -f "$OLLAMA_DIR/bin/ollama" ]; then
            mv "$OLLAMA_DIR/bin/ollama" "$OLLAMA_EXE"
            rm -rf "$OLLAMA_DIR/bin"
        fi
        
        chmod +x "$OLLAMA_EXE"
        [ "$PLATFORM" = "darwin" ] && xattr -d com.apple.quarantine "$OLLAMA_EXE" 2>/dev/null || true
        echo -e "      ${GREEN}Engine Installed successfully!${RESET}"
    else
        echo -e "      ${RED}ERROR: Failed to download engine!${RESET}"
        exit 1
    fi
fi

echo -e "\n${YELLOW}[4/4] Pulling Models via Ollama (Guarantees Tool Support)...${RESET}"

export OLLAMA_MODELS="$OLLAMA_DIR/data"
echo -e "\n      ${DIM}Starting background Ollama server...${RESET}"
"$OLLAMA_EXE" serve >/dev/null 2>&1 &
SERVER_PID=$!
sleep 5

ERRORS=0
for i in "${!SELECTED_TAGS[@]}"; do
    TAG="${SELECTED_TAGS[$i]}"
    NAME="${SELECTED_NAMES[$i]}"
    
    if [[ "$TAG" == http* ]] && [[ "$TAG" == *.gguf* ]]; then
        FILE_NAME=$(basename "${TAG%%\?*}")
        [[ "$FILE_NAME" != *.gguf ]] && FILE_NAME="${FILE_NAME}.gguf"
        DEST="$MODELS_DIR/$FILE_NAME"
        
        MODEL_NAME="${FILE_NAME%.*}-local"
        MODEL_NAME=$(echo "$MODEL_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g')

        # --- Always verify real file size against server ---
        echo -e "\n  ${YELLOW}($((i+1))/${#SELECTED_MODELS[@]}) Checking $NAME...${RESET}"
        EXPECTED_SIZE=$(curl -sIL "$TAG" 2>/dev/null | grep -i content-length | tail -1 | awk '{print $2}' | tr -d '\r')
        EXISTING_SIZE=0
        if [ -f "$DEST" ]; then
            EXISTING_SIZE=$(stat -f%z "$DEST" 2>/dev/null || stat --printf="%s" "$DEST" 2>/dev/null || echo "0")
        fi

        FILE_COMPLETE=0
        if [ -n "$EXPECTED_SIZE" ] && [ "$EXPECTED_SIZE" -gt 0 ] 2>/dev/null && [ "$EXISTING_SIZE" -ge "$EXPECTED_SIZE" ] 2>/dev/null; then
            FILE_COMPLETE=1
        fi

        # Only skip if file is FULLY downloaded AND ollama has it imported
        if [ "$FILE_COMPLETE" -eq 1 ] && "$OLLAMA_EXE" show "$MODEL_NAME" >/dev/null 2>&1; then
            echo -e "  ${GREEN}✅ $NAME fully downloaded ($(( EXISTING_SIZE / 1024 / 1024 )) MB) & imported — skipping!${RESET}"
            SELECTED_TAGS[$i]="$MODEL_NAME"
            continue
        fi

        echo -e "      ${MAGENTA}Do not close this window! Download may take a while.${RESET}"

        # --- Download or resume ---
        if [ -f "$DEST" ] && [ "$FILE_COMPLETE" -eq 0 ]; then
            EXISTING_MB=$(( EXISTING_SIZE / 1024 / 1024 ))
            EXPECTED_MB=$(( ${EXPECTED_SIZE:-0} / 1024 / 1024 ))
            echo -e "      ${YELLOW}$FILE_NAME is incomplete (${EXISTING_MB}MB / ${EXPECTED_MB}MB). Resuming...${RESET}"
            echo -e "      ${DIM}(Speed + ETA shown below)${RESET}"
            curl -L -C - "$TAG" -o "$DEST"
        elif [ "$FILE_COMPLETE" -eq 0 ]; then
            echo -e "      ${CYAN}Downloading $FILE_NAME (speed + ETA shown below)...${RESET}"
            curl -L -C - "$TAG" -o "$DEST"
        fi
        
        echo -e "FROM ./$FILE_NAME\nPARAMETER temperature 0.7\nPARAMETER top_p 0.9" > "$MODELS_DIR/Modelfile-$MODEL_NAME"
        
        echo -e "      ${CYAN}Importing into Ollama as '$MODEL_NAME'...${RESET}"
        pushd "$MODELS_DIR" >/dev/null
        if "$OLLAMA_EXE" create "$MODEL_NAME" -f "Modelfile-$MODEL_NAME"; then
            echo -e "      ${GREEN}Import complete!${RESET}"
            SELECTED_TAGS[$i]="$MODEL_NAME"
        else
            echo -e "      ${RED}FAILED to import custom model: $FILE_NAME${RESET}"
            ERRORS=$((ERRORS+1))
        fi
        popd >/dev/null
        continue
    fi
    
    # --- Check if standard Ollama model already exists ---
    if "$OLLAMA_EXE" show "$TAG" >/dev/null 2>&1; then
        echo -e "\n  ${GREEN}($((i+1))/${#SELECTED_MODELS[@]}) ✅ $NAME [$TAG] already pulled — skipping!${RESET}"
        continue
    fi

    echo -e "\n  ${YELLOW}($((i+1))/${#SELECTED_MODELS[@]}) Pulling $NAME [$TAG]...${RESET}"
    echo -e "      ${MAGENTA}Do not close this window! Download may take a while.${RESET}"
    
    if "$OLLAMA_EXE" pull "$TAG"; then
        echo -e "      ${GREEN}Pull complete!${RESET}"
    else
        echo -e "      ${RED}FAILED to pull model: $TAG${RESET}"
        ERRORS=$((ERRORS+1))
    fi
done

echo -e "\n      ${DIM}Stopping background Ollama server...${RESET}"
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true

# Record Models for the Dashboard
if [ ${#SELECTED_TAGS[@]} -gt 0 ]; then
    for i in "${!SELECTED_TAGS[@]}"; do
        echo "${SELECTED_TAGS[$i]}|${SELECTED_NAMES[$i]}|LOCAL" >> "$MODELS_DIR/installed-models.txt"
    done
    sort -u "$MODELS_DIR/installed-models.txt" -o "$MODELS_DIR/installed-models.txt"
fi

DEFAULT_MODEL="${SELECTED_TAGS[0]}"
bash "$ROOT_DIR/start.sh" use-ollama "$DEFAULT_MODEL"

echo -e "\n${YELLOW}[5/5] Finalizing Configurations...${RESET}"
echo -e "      ${GREEN}Default Model set to: $DEFAULT_MODEL${RESET}"

echo -e "\n${CYAN}=========================================================${RESET}"
if [ "$ERRORS" -gt 0 ]; then
    echo -e "   ${YELLOW}SETUP COMPLETE (with some download errors)${RESET}"
else
    echo -e "   ${GREEN}SETUP COMPLETE! LOCAL AI AGENTS ARE READY!${RESET}"
fi
echo -e "${CYAN}=========================================================${RESET}"
echo -e "\n  ${BOLD}Run start.sh to begin!${RESET}\n"
